import { validatePiToolArguments } from "../packages/llm/llm-pi-ai/src/index.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { CancelToken } from "../packages/core/runtime-protocol/src/index.ts";
import { ToolRegistry, ToolRuntime, toolVersion, type ToolAdapterDefinition } from "../packages/core/tools/src/index.ts";

function tool(name: string, value = name): ToolAdapterDefinition {
  return { spec: { name, description: name, parameters: { type: "object", properties: {} }, promptGuidelines: [] },
    execute: () => ({ ok: true, content: value }) };
}

test("owner replacement is atomic and cannot replace builtins or another owner", () => {
  const registry = new ToolRegistry([tool("read")]);
  registry.replaceOwner("one", [tool("a")]);
  registry.replaceOwner("two", [tool("b")]);
  assert.throws(() => registry.replaceOwner("one", [tool("c"), tool("read")]));
  assert.throws(() => registry.replaceOwner("one", [tool("b")]));
  assert.throws(() => registry.replaceOwner("one", [tool("c"), tool("c")]));
  assert.throws(() => registry.replaceOwner("builtin", []));
  assert.deepEqual(registry.definitions.map(t => t.name), ["read", "a", "b"]);
});

test("old snapshots retain schema but reject revoked adapters", async () => {
  const registry = new ToolRegistry([]);
  const definition = tool("remote");
  registry.replaceOwner("one", [definition]);
  const snapshot = registry.snapshot();
  definition.spec.parameters.type = "string";
  assert.equal(snapshot.definitions[0]?.parameters.type, "object");
  registry.replaceOwner("one", [tool("remote", "new target")]);
  assert.equal((await snapshot.execute("remote", {})).status, "tool_unavailable");
  assert.equal((await registry.execute("remote", {})).content, "new target");
  const current = registry.snapshot();
  registry.removeOwner("one");
  assert.equal((await current.execute("remote", {})).status, "tool_unavailable");
});

test("output schema survives registry snapshots and changes the tool version", () => {
  const original = tool("remote");
  const outputSchema = { type: "object", properties: { count: { type: "number" } } };
  const definition = { ...original, spec: { ...original.spec, outputSchema } };
  const registry = new ToolRegistry([definition]);
  const snapshot = registry.snapshot();
  outputSchema.properties.count.type = "string";
  assert.deepEqual(snapshot.definitions[0]?.outputSchema, { type: "object", properties: { count: { type: "number" } } });
  assert.notEqual(toolVersion(original.spec), toolVersion(snapshot.definitions[0]!));
  assert.notEqual(toolVersion({ ...original.spec, outputSchema: false }), toolVersion(original.spec));
});

test("tool runtime executes the request snapshot and forwards cancellation signal", async () => {
  const registry = new ToolRegistry([tool("a", "wrong")]);
  const token = new CancelToken();
  let observed: AbortSignal | undefined;
  const snapshot = new ToolRegistry([{ ...tool("a"), execute: (_args, ctx) => {
    observed = ctx.signal;
    token.cancel("cancel the owning turn");
    return { ok: true, content: "snapshot" };
  } }]).snapshot();
  const result = await new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments }).execute({ registry: snapshot,
    toolCalls: [{ id: "1", name: "a", arguments: "{}" }], executionMode: "parallel", cancelToken: token });
  assert.equal(result.results[0]?.content, "snapshot");
  assert.equal(observed?.aborted, true);
  assert.equal(observed?.reason?.message, "cancel the owning turn");
});
