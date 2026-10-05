import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry, ToolRuntime, type ToolSpec, type ToolRuntimeToolResultEvent } from "../packages/core/tools/src/index.ts";
import { validatePiToolArguments } from "../packages/llm/llm-pi-ai/src/index.ts";

const spec: ToolSpec = {
  name: "inspect",
  description: "Inspect a local fixture",
  promptGuidelines: [],
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "limit", "mode"],
    properties: {
      path: { type: "string" },
      limit: { type: "integer", minimum: 1 },
      mode: { type: "string", enum: ["lines", "bytes"] },
      enabled: { type: "boolean" },
      items: {
        type: "array",
        items: {
          type: "object", required: ["count"],
          properties: { count: { type: "integer", minimum: 1 } },
        },
      },
    },
  },
};

function call(args: Record<string, unknown>, name = spec.name, id = "call-1") {
  return { id, name, arguments: JSON.stringify(args) };
}

test("SDK tool validation converts nested arguments without changing the original", () => {
  const args = { path: "a.txt", limit: "20", mode: "lines", enabled: "false", items: [{ count: "2" }] };
  const original = structuredClone(args);
  const validated = validatePiToolArguments(spec, call(args), args);
  assert.deepEqual(validated, { path: "a.txt", limit: 20, mode: "lines", enabled: false, items: [{ count: 2 }] });
  assert.deepEqual(args, original);
  assert.notEqual(validated, args);
});

test("SDK tool validation retains valid values and removes non-nullable optional nulls", () => {
  const args = { path: "a.txt", limit: 20, mode: "lines", enabled: null };
  assert.deepEqual(validatePiToolArguments(spec, call(args), args), { path: "a.txt", limit: 20, mode: "lines" });
  assert.equal(args.enabled, null);
});

for (const [label, args, field] of [
  ["missing required field", { limit: 20, mode: "lines" }, "path"],
  ["unconvertible type", { path: "a.txt", limit: "wrong", mode: "lines" }, "limit"],
  ["out of range", { path: "a.txt", limit: 0, mode: "lines" }, "limit"],
  ["invalid enum", { path: "a.txt", limit: 20, mode: "wrong" }, "mode"],
  ["extra field", { path: "a.txt", limit: 20, mode: "lines", secret: "PRIVATE_BODY" }, "secret"],
] as const) {
  test(`SDK tool validation rejects ${label} without echoing the raw input`, () => {
    assert.throws(() => validatePiToolArguments(spec, call(args), args), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Validation failed for tool "inspect"/);
      if (label !== "extra field") assert.ok(error.message.includes(field));
      assert.doesNotMatch(error.message, /Received arguments|PRIVATE_BODY|a\.txt/);
      return true;
    });
  });
}

test("ToolRuntime requires a validator rather than silently bypassing validation", () => {
  assert.throws(() => new ToolRuntime(new ToolRegistry([]), {} as ConstructorParameters<typeof ToolRuntime>[1]), /validator is required/);
});

for (const executionMode of ["parallel", "sequential"] as const) {
  test(`ToolRuntime validates every ${executionMode} call and pairs failures in source order`, async () => {
    const executed: Record<string, unknown>[] = [];
    const events: ToolRuntimeToolResultEvent[] = [];
    const registry = new ToolRegistry([{ spec, execute: args => { executed.push(args); return { ok: true }; } }]);
    const runtime = new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments });
    const input = { path: "a.txt", limit: "20", mode: "lines" };
    const calls = [
      call({ path: "a.txt", limit: "wrong", mode: "lines" }, spec.name, "invalid"),
      call(input, spec.name, "valid"),
      call(input, "unknown", "unknown"),
      { id: "array", name: spec.name, arguments: "[]" },
    ];
    const batch = await runtime.execute({ toolCalls: calls, executionMode, cancelToken: null, onToolResult: event => events.push(event) });
    assert.deepEqual(batch.results.map(result => result.ok), [false, true, false, false]);
    assert.match(String(batch.results[0]?.error), /limit/);
    assert.match(String(batch.results[2]?.error), /Unknown tool: unknown/);
    assert.match(String(batch.results[3]?.error), /JSON object/);
    assert.deepEqual(executed, [{ path: "a.txt", limit: 20, mode: "lines" }]);
    assert.deepEqual(events.map(event => event.toolCall.id).sort(), ["array", "invalid", "unknown", "valid"]);
    assert.deepEqual(events.find(event => event.toolCall.id === "valid")?.args, executed[0]);
    assert.equal(JSON.parse(calls[1]!.arguments).limit, "20");
  });
}

test("ToolRuntime validates against the same snapshot used for execution", async () => {
  let executions = 0;
  const definition = { spec, execute: () => { executions++; return { ok: true }; } };
  const registry = new ToolRegistry([definition]);
  const snapshot = new ToolRegistry([{ ...definition, spec: { ...spec, parameters: {
    ...spec.parameters,
    properties: { path: { type: "string" }, limit: { type: "integer", minimum: 100 }, mode: { type: "string" } },
  } } }]).snapshot();
  const runtime = new ToolRuntime(registry, { validateToolArguments: validatePiToolArguments });
  const batch = await runtime.execute({ registry: snapshot, toolCalls: [call({ path: "a.txt", limit: 20, mode: "lines" })], executionMode: "parallel", cancelToken: null });
  assert.equal(batch.results[0]?.ok, false);
  assert.match(String(batch.results[0]?.error), /limit/);
  assert.equal(executions, 0);
});
