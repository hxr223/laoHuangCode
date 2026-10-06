import assert from "node:assert/strict";
import test from "node:test";
import { ToolRegistry, ToolSelection, toolVersion, type ToolAdapterDefinition } from "../packages/core/tools/src/index.ts";
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
  const full = selection.prepare(registry);
  assert.equal(full.view.definitions.length, 19);
  assert.equal(full.announcement, undefined);
  assert.equal(full.update.toolsAdded.length, 19);
  selection.apply(full.update);
  registry.replaceOwner("mcp:issues", Array.from({ length: 16 }, (_, i) => tool(`issue_${i}`)));
  const selected = selection.prepare(registry);
  assert.deepEqual(selected.view.definitions.map(t => t.name), ["read", "write", "edit", "bash", "tool_search"]);
  assert.match(selected.announcement!.content, /<tools_added>/);
  assert.equal(selected.update.toolsRemoved.length, 15);
  selection.apply(selected.update);
  assert.equal((await selected.view.execute("issue_0", {})).status, "tool_not_loaded");
  await selected.view.execute("tool_search", { query: "issue_0", limit: 1 });
  assert.equal((await selected.view.execute("issue_0", {})).ok, false, "loading takes effect next step");
  selection.apply({ toolsAdded: selected.pending(), toolsRemoved: [] });
  const next = selection.prepare(registry);
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
  const selected = selection.prepare(registry);
  assert.equal((await selected.view.execute("tool_search", { query: "ticket number", limit: 1 })).matches?.length, 1);
  assert.equal((await selected.view.execute("tool_search", { query: "工单", limit: 1 })).matches?.length, 1);
  assert.deepEqual((await selected.view.execute("tool_search", { query: "nonexistent" })).matches, []);
});

test("search validates limits and loads matches without a separate budget gate", async () => {
  const { registry, selection } = setup();
  const selected = selection.prepare(registry);
  for (const args of [{ query: "" }, { query: "x", limit: 21 }, { query: "x", limit: 1.5 }, { query: "x", extra: 1 }]) {
    assert.equal((await selected.view.execute("tool_search", args)).ok, false);
  }
  const result = await selected.view.execute("tool_search", { query: "issue_0", limit: 1 });
  assert.equal((result.matches as { status: string }[])[0]?.status, "loaded");
  assert.equal(selected.pending()[0]?.spec.name, "issue_0");
});

test("snapshot restores active tools, refreshes changed definitions, and removes missing tools", async () => {
  const { registry, selection } = setup(17);
  const initial = selection.prepare(registry);
  selection.apply(initial.update);
  await initial.view.execute("tool_search", { query: "issue_0", limit: 1 });
  selection.apply({ toolsAdded: initial.pending(), toolsRemoved: [] });
  const restored = new ToolSelection();
  restored.restore(structuredClone(selection.snapshot()));
  assert.ok(restored.prepare(registry).view.definitions.some(t => t.name === "issue_0"));
  const changed = tool("issue_0", true, "changed").spec;
  assert.notEqual(toolVersion(changed), initial.pending()[0]!.version);
  registry.replaceOwner("mcp:issues", [tool("issue_0", true, "changed"), ...Array.from({ length: 16 }, (_, i) => tool(`issue_${i + 1}`))]);
  const refreshed = restored.prepare(registry);
  assert.deepEqual(refreshed.update.toolsRemoved.map(tool => tool.name), ["issue_0"]);
  assert.deepEqual(refreshed.update.toolsAdded.map(tool => tool.spec.name), ["issue_0"]);
  assert.equal(refreshed.update.toolsAdded[0]?.activation, "search");
  assert.equal(refreshed.view.definitions.find(tool => tool.name === "issue_0")?.description, "changed");
  restored.apply(refreshed.update);
  registry.replaceOwner("mcp:issues", Array.from({ length: 16 }, (_, i) => tool(`issue_${i + 1}`)));
  const removed = restored.prepare(registry);
  assert.deepEqual(removed.missing, ["issue_0"]);
  assert.deepEqual(removed.update.toolsRemoved.map(tool => tool.name), ["issue_0"]);
  assert.ok(!removed.view.definitions.some(t => t.name === "issue_0"));
});
