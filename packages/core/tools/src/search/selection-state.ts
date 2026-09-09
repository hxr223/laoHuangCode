import type { ToolRegistryLike, ToolSpec } from "../index.ts";
import { canonicalToolJson, toolSearchText, toolVersion, type LoadedTool, type ToolCatalogState, type ToolSelectionRecord } from "./catalog.ts";
import { Bm25Index } from "./bm25.ts";
import { SEARCH_TOOL_NAME, SEARCH_TOOL_SPEC } from "./search-tool.ts";

export const TOOL_SEARCH_THRESHOLD = 20;

/** Per-agent cache. Loaded state always comes from the retained context, not this cache. */
export class ToolSelection {
  private indexKey = "";
  private index: Bm25Index | undefined;

  prepare(registry: ToolRegistryLike, records: readonly ToolSelectionRecord[], canLoad: (tools: readonly LoadedTool[], resultBytes: number) => boolean | Promise<boolean> = () => true,
    retainedRecords?: () => readonly ToolSelectionRecord[]) {
    const all = registry.definitions.filter(spec => spec.name !== SEARCH_TOOL_NAME);
    const deferred = all.filter(spec => spec.catalog?.exposure === "deferred");
    const mode = all.length >= TOOL_SEARCH_THRESHOLD ? "deferred" : "full";
    const versions = new Map(deferred.map(spec => [spec.name, toolVersion(spec)]));
    const catalog: ToolCatalogState = { mode, tools: mode === "deferred" ? Object.fromEntries(versions) : {} };
    let previous: ToolCatalogState | undefined;
    const loaded = loadedVersions(records, versions);
    for (const record of records) {
      if (record.toolCatalog) {
        previous = record.toolCatalog;
      }
    }
    const changed = canonicalToolJson(previous ?? { mode: "full", tools: {} }) !== canonicalToolJson(catalog);
    let announcement: { content: string; toolCatalog: ToolCatalogState } | undefined;
    if (changed) {
      const before = previous?.mode === "deferred" && mode === "deferred" ? previous.tools : {};
      const added = Object.keys(catalog.tools).filter(name => before[name] !== catalog.tools[name]);
      const removed = Object.keys(before).filter(name => before[name] !== catalog.tools[name]);
      const sections = ["<system-reminder>", mode === "deferred" ? "Use tool_search to search and load tool definitions before calling deferred tools." : "All currently available tool definitions are now directly available."];
      if (removed.length) sections.push("<tools_removed>", ...removed, "</tools_removed>");
      if (added.length) sections.push("<tools_added>", ...added, "</tools_added>");
      sections.push("</system-reminder>");
      announcement = { content: sections.join("\n"), toolCatalog: catalog };
    }
    if (mode === "deferred") {
      const key = canonicalToolJson(catalog.tools);
      if (!this.index || this.indexKey !== key) {
        this.index = new Bm25Index(deferred.map(spec => ({ name: spec.name, text: toolSearchText(spec) })));
        this.indexKey = key;
      }
    }
    const pending = new Map<string, LoadedTool>();
    let resultBytes = 0;
    const definitions = mode === "full" ? all : [...all.filter(spec => spec.catalog?.exposure !== "deferred" || loaded.has(spec.name)), SEARCH_TOOL_SPEC];
    const visible = new Set(definitions.map(spec => spec.name));
    const index = this.index;
    const view: ToolRegistryLike = {
      definitions, orderedSpecs: definitions,
      executionMode: name => name === SEARCH_TOOL_NAME ? "sequential" : registry.executionMode(name),
      execute: async (name, args, context) => {
        if (context?.isCancelled()) return { ok: false, status: "cancelled", error: context.cancellationReason };
        if (!visible.has(name)) return { ok: false, status: "tool_not_loaded", error: "Tool is unavailable or not loaded. Use tool_search with its name to load the current definition." };
        if (name !== SEARCH_TOOL_NAME) return registry.execute(name, args, context);
        const query = args.query, limit = args.limit ?? 8;
        if (typeof query !== "string" || !query.trim() || query.length > 4096 || typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20 || Object.keys(args).some(key => key !== "query" && key !== "limit")) {
          return { ok: false, error: "Expected nonempty query (at most 4096 characters) and integer limit from 1 to 20." };
        }
        const matches = (index?.search(query, limit) ?? []).map(name => {
          const spec = deferred.find(tool => tool.name === name)!;
          return { name, description: spec.description.length > 1024 ? `${spec.description.slice(0, 1024)}...[truncated]` : spec.description,
            source: spec.catalog?.source, status: "not_loaded_budget" };
        });
        resultBytes += Buffer.byteLength(JSON.stringify({ ok: true, matches }), "utf8");
        const previouslyPending = new Set(pending.keys());
        // A budget preflight may compact old definitions. Recheck earlier hits
        // once after it; the agent permits at most one preflight per model step.
        for (let pass = 0; pass < (retainedRecords ? 2 : 1); pass++) {
          const retained = retainedRecords ? loadedVersions(retainedRecords(), versions) : loaded;
          for (const match of matches) {
            const { name } = match;
            if (pending.has(name)) { match.status = previouslyPending.has(name) ? "already_loaded" : "loaded"; continue; }
            if (retained.has(name)) { match.status = "already_loaded"; continue; }
            if (pass > 0 && match.status === "not_loaded_budget") continue;
            const spec = deferred.find(tool => tool.name === name)!;
            const tool = { spec, version: versions.get(name)! };
            if (await canLoad([...pending.values(), tool], resultBytes)) { pending.set(name, tool); match.status = "loaded"; }
            else match.status = "not_loaded_budget";
          }
        }
        return { ok: true, matches, ...(matches.length ? {} : { content: "No matching tools. Try an exact name, source, or different keywords." }) };
      },
    };
    return { view, announcement, mode, pending: () => [...pending.values()] };
  }
}

function loadedVersions(records: readonly ToolSelectionRecord[], versions: ReadonlyMap<string, string>): Map<string, string> {
  const loaded = new Map<string, string>();
  for (const record of records) {
    if (record.toolCatalog?.mode === "deferred") {
      for (const [name, version] of loaded) if (record.toolCatalog.tools[name] !== version) loaded.delete(name);
    }
    for (const tool of record.toolDefinitions ?? []) loaded.set(tool.spec.name, tool.version);
  }
  for (const [name, version] of loaded) if (versions.get(name) !== version) loaded.delete(name);
  return loaded;
}
