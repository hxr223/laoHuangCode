import type { ToolRegistryLike, ToolSpec } from "../index.ts";
import {
  canonicalToolJson,
  toolSearchText,
  toolVersion,
  type ActiveTool,
  type ToolCatalogState,
  type ToolSelectionSnapshot,
  type ToolStateUpdate,
} from "./catalog.ts";
import { Bm25Index } from "./bm25.ts";
import { SEARCH_TOOL_NAME, SEARCH_TOOL_SPEC } from "./search-tool.ts";

export const TOOL_SEARCH_THRESHOLD = 20;

/** Per-agent tool loadout. Conversation messages never own active tool state. */
export class ToolSelection {
  private indexKey = "";
  private index: Bm25Index | undefined;
  private catalog: ToolCatalogState | null = null;
  private readonly active = new Map<string, ActiveTool>();

  apply(update: ToolStateUpdate): void {
    if (update.catalog !== undefined) this.catalog = copyCatalog(update.catalog);
    for (const removed of update.toolsRemoved) {
      const current = this.active.get(removed.name);
      if (current !== undefined && (removed.version === undefined || current.version === removed.version)) {
        this.active.delete(removed.name);
      }
    }
    for (const tool of update.toolsAdded) this.active.set(tool.spec.name, copyActiveTool(tool));
  }

  restore(snapshot: ToolSelectionSnapshot): void {
    this.catalog = snapshot.catalog === null ? null : copyCatalog(snapshot.catalog);
    this.active.clear();
    for (const tool of snapshot.activeTools) this.active.set(tool.spec.name, copyActiveTool(tool));
  }

  snapshot(): ToolSelectionSnapshot {
    return {
      catalog: this.catalog === null ? null : copyCatalog(this.catalog),
      activeTools: [...this.active.values()].map(copyActiveTool),
    };
  }

  prepare(registry: ToolRegistryLike) {
    const all = registry.definitions.filter(spec => spec.name !== SEARCH_TOOL_NAME);
    const deferred = all.filter(spec => spec.catalog?.exposure === "deferred");
    const mode = all.length >= TOOL_SEARCH_THRESHOLD ? "deferred" : "full";
    const versions = new Map(all.map(spec => [spec.name, toolVersion(spec)]));
    const catalog: ToolCatalogState = {
      mode,
      tools: mode === "deferred"
        ? Object.fromEntries(deferred.map(spec => [spec.name, versions.get(spec.name)!]))
        : {},
    };
    const current = new Map(all.map(spec => [spec.name, spec]));
    const desired = new Map<string, ActiveTool>();
    const toolsAdded: ActiveTool[] = [];
    const toolsRemoved: { name: string; version?: string }[] = [];
    const missing: string[] = [];
    for (const [name, active] of this.active) {
      const spec = current.get(name);
      if (spec === undefined) {
        toolsRemoved.push({ name, version: active.version });
        missing.push(name);
        continue;
      }
      const baseline = mode === "full" || spec.catalog?.exposure !== "deferred";
      const version = versions.get(name)!;
      if (version !== active.version) {
        toolsRemoved.push({ name, version: active.version });
        if (baseline || active.activation === "search") {
          const updated = {
            spec,
            version,
            activation: spec.catalog?.exposure === "deferred" && active.activation === "search"
              ? "search" as const
              : "baseline" as const,
          };
          desired.set(name, updated);
          toolsAdded.push(updated);
        }
        continue;
      }
      if (baseline || active.activation === "search") {
        desired.set(name, { spec, version, activation: active.activation });
      } else {
        toolsRemoved.push({ name, version: active.version });
      }
    }
    for (const spec of all) {
      const baseline = mode === "full" || spec.catalog?.exposure !== "deferred";
      if (!baseline || desired.has(spec.name)) continue;
      const added = { spec, version: versions.get(spec.name)!, activation: "baseline" as const };
      desired.set(spec.name, added);
      toolsAdded.push(added);
    }
    const catalogChanged = canonicalToolJson(this.catalog ?? { mode: "full", tools: {} }) !== canonicalToolJson(catalog);
    const update: ToolStateUpdate = {
      ...(catalogChanged ? { catalog } : {}),
      toolsAdded,
      toolsRemoved,
    };
    const loaded = new Map([...desired].map(([name, tool]) => [name, tool.version]));
    let announcement: { content: string; toolCatalog: ToolCatalogState } | undefined;
    if (catalogChanged) {
      const before = this.catalog?.mode === "deferred" && mode === "deferred" ? this.catalog.tools : {};
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
    const pending = new Map<string, ActiveTool>();
    const definitions = [
      ...all.filter(spec => desired.has(spec.name)),
      ...(mode === "deferred" ? [SEARCH_TOOL_SPEC] : []),
    ];
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
            source: spec.catalog?.source, status: "loaded" };
        });
        for (const match of matches) {
          const { name } = match;
          if (pending.has(name) || loaded.has(name)) {
            match.status = "already_loaded";
            continue;
          }
          const spec = deferred.find(tool => tool.name === name)!;
          pending.set(name, { spec, version: versions.get(name)!, activation: "search" });
        }
        return { ok: true, matches, ...(matches.length ? {} : { content: "No matching tools. Try an exact name, source, or different keywords." }) };
      },
    };
    return { view, announcement, mode, update, missing, pending: () => [...pending.values()] };
  }
}

function copyCatalog(catalog: ToolCatalogState): ToolCatalogState {
  return { mode: catalog.mode, tools: { ...catalog.tools } };
}

function copyActiveTool(tool: ActiveTool): ActiveTool {
  return { version: tool.version, spec: tool.spec, activation: tool.activation };
}
