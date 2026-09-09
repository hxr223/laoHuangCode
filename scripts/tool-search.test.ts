import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry, ToolSelection, toolVersion, type ToolAdapterDefinition, type ToolSelectionRecord } from "../packages/core/tools/src/index.ts";
import { Bm25Index } from "../packages/core/tools/src/search/bm25.ts";

function tool(name: string, deferred = true, description = name): ToolAdapterDefinition {
  return { spec: { name, description, parameters: { type: "object", properties: { ticketNumber: { type: "string", description: "工单编号" } } }, promptGuidelines: [],
    ...(deferred ? { catalog: { source: "mcp:issues", originalName: name, binding: "one", exposure: "deferred" as const } } : {}) }, execute: () => ({ ok: true }) };
}
function setup(count = 16) {
  const registry = new ToolRegistry(["read", "write", "edit", "bash"].map(name => tool(name, false)));
  registry.replaceOwner("mcp:issues", Array.from({ length: count }, (_, i) => tool(`issue_${i}`)));
  return { registry, selection: new ToolSelection() };
}

test("19 tools are full, 20 enable search while four basic tools stay direct", async () => {
  const { registry, selection } = setup(15);
  assert.equal(selection.prepare(registry, []).view.definitions.length, 19);
  assert.equal(selection.prepare(registry, []).announcement, undefined);
  registry.replaceOwner("mcp:issues", Array.from({ length: 16 }, (_, i) => tool(`issue_${i}`)));
  const selected = selection.prepare(registry, []);
  assert.deepEqual(selected.view.definitions.map(t => t.name), ["read", "write", "edit", "bash", "tool_search"]);
  assert.match(selected.announcement!.content, /<tools_added>/);
  assert.equal((await selected.view.execute("issue_0", {})).status, "tool_not_loaded");
  await selected.view.execute("tool_search", { query: "issue_0", limit: 1 });
  assert.equal((await selected.view.execute("issue_0", {})).ok, false, "loading takes effect next step");
  const records = [selected.announcement!, { toolDefinitions: selected.pending() }];
  const next = selection.prepare(registry, records);
  assert.equal(next.announcement, undefined);
  assert.equal((await next.view.execute("issue_0", {})).ok, true);
  assert.deepEqual((await next.view.execute("tool_search", { query: "issue_0", limit: 1 })).matches,
    [{ name: "issue_0", description: "issue_0", source: "mcp:issues", status: "already_loaded" }]);
  assert.equal(next.pending().length, 0);
});

test("BM25 ranks rare terms, exact names, schema words and Chinese; ties are stable", async () => {
  const index = new Bm25Index([{ name: "b", text: "common unique" }, { name: "a", text: "common" }, { name: "c", text: "common" }]);
  assert.equal(index.search("unique", 1)[0], "b");
  assert.equal(index.search("b", 1)[0], "b");
  assert.deepEqual(index.search("common", 3), ["a", "c", "b"]);
  const { registry, selection } = setup();
  const selected = selection.prepare(registry, []);
  assert.equal((await selected.view.execute("tool_search", { query: "ticket number", limit: 1 })).matches?.length, 1);
  assert.equal((await selected.view.execute("tool_search", { query: "工单", limit: 1 })).matches?.length, 1);
  assert.deepEqual((await selected.view.execute("tool_search", { query: "nonexistent" })).matches, []);
});

test("search validates limits and reports budget failure without publishing a partial schema", async () => {
  const { registry, selection } = setup();
  const selected = selection.prepare(registry, [], () => false);
  for (const args of [{ query: "" }, { query: "x", limit: 21 }, { query: "x", limit: 1.5 }, { query: "x", extra: 1 }]) {
    assert.equal((await selected.view.execute("tool_search", args)).ok, false);
  }
  const result = await selected.view.execute("tool_search", { query: "issue_0", limit: 1 });
  assert.equal((result.matches as { status: string }[])[0]?.status, "not_loaded_budget");
  assert.deepEqual(selected.pending(), []);
});

test("retained structured definitions govern loading, changed/removed definitions cannot revive", async () => {
  const { registry, selection } = setup(17);
  const initial = selection.prepare(registry, []);
  await initial.view.execute("tool_search", { query: "issue_0", limit: 1 });
  const records: ToolSelectionRecord[] = [initial.announcement!, { toolDefinitions: initial.pending() }];
  assert.ok(new ToolSelection().prepare(registry, structuredClone(records)).view.definitions.some(t => t.name === "issue_0"));
  assert.ok(!selection.prepare(registry, [{ toolCatalog: initial.announcement!.toolCatalog }]).view.definitions.some(t => t.name === "issue_0"));
  registry.replaceOwner("mcp:issues", Array.from({ length: 16 }, (_, i) => tool(`issue_${i + 1}`)));
  const removed = selection.prepare(registry, records);
  assert.match(removed.announcement!.content, /<tools_removed>\nissue_0/);
  records.push(removed.announcement!);
  registry.replaceOwner("mcp:issues", Array.from({ length: 17 }, (_, i) => tool(`issue_${i}`)));
  assert.ok(!selection.prepare(registry, records).view.definitions.some(t => t.name === "issue_0"));
  const changed = tool("issue_0", true, "changed").spec;
  assert.notEqual(toolVersion(changed), initial.pending()[0]!.version);
  registry.removeOwner("mcp:issues");
  assert.deepEqual(selection.prepare(registry, records).view.definitions.map(t => t.name), ["read", "write", "edit", "bash"]);
});

test("a search rechecks earlier already-loaded hits after budget preflight compacts them", async () => {
  const { registry, selection } = setup();
  const initial = selection.prepare(registry, []);
  await initial.view.execute("tool_search", { query: "issue_0", limit: 1 });
  let retained: ToolSelectionRecord[] = [initial.announcement!, { toolDefinitions: initial.pending() }];
  const selected = selection.prepare(registry, retained, () => { retained = [initial.announcement!]; return true; }, () => retained);
  const result = await selected.view.execute("tool_search", { query: "issue", limit: 20 });
  assert.equal((result.matches as { name: string; status: string }[]).find(m => m.name === "issue_0")?.status, "loaded");
  assert.ok(selected.pending().some(tool => tool.spec.name === "issue_0"));
});
