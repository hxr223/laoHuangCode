import type { SessionEntry } from "@laohuang/session-store";
import type {
  ActiveTool,
  LoadedTool,
  ToolCatalogState,
  ToolSelectionSnapshot,
} from "@laohuang/tools";

/** Rebuild durable active-tool state without projecting it into model messages. */
export function projectToolSelectionState(entries: readonly SessionEntry[]): ToolSelectionSnapshot {
  const sorted = [...entries].sort((left, right) => left.seq - right.seq);
  const latestCompaction = [...sorted].reverse().find(entry => entry.entryType === "compaction");
  const checkpoint = latestCompaction?.entryType === "compaction" && latestCompaction.payload.toolState !== undefined
    ? latestCompaction
    : undefined;
  let catalog: ToolCatalogState | null = checkpoint?.entryType === "compaction"
    ? copyCatalog(checkpoint.payload.toolState!.catalog)
    : null;
  const active = new Map<string, ActiveTool>();
  if (checkpoint?.entryType === "compaction") {
    for (const tool of checkpoint.payload.toolState!.activeTools) {
      active.set(tool.spec.name, copyActiveTool(tool));
    }
  }
  const afterSeq = checkpoint?.seq ?? 0;
  for (const entry of sorted) {
    if (entry.seq <= afterSeq) continue;
    if (entry.entryType === "tool_catalog") {
      catalog = copyCatalog(entry.payload.message.toolCatalog ?? null);
      continue;
    }
    if (entry.entryType !== "tool_definitions") continue;
    for (const removed of entry.payload.message.toolsRemoved ?? []) {
      const current = active.get(removed.name);
      if (current !== undefined && (removed.version === undefined || current.version === removed.version)) {
        active.delete(removed.name);
      }
    }
    for (const tool of entry.payload.message.toolDefinitions ?? []) {
      const activeTool = normalizeActiveTool(tool);
      active.set(activeTool.spec.name, activeTool);
    }
  }
  return { catalog, activeTools: [...active.values()] };
}

function normalizeActiveTool(tool: LoadedTool): ActiveTool {
  const activation = "activation" in tool && (tool.activation === "baseline" || tool.activation === "search")
    ? tool.activation
    : "search";
  return { version: tool.version, spec: tool.spec, activation };
}

function copyCatalog(catalog: ToolCatalogState | null): ToolCatalogState | null {
  return catalog === null ? null : { mode: catalog.mode, tools: { ...catalog.tools } };
}

function copyActiveTool(tool: ActiveTool): ActiveTool {
  return { version: tool.version, spec: tool.spec, activation: tool.activation };
}
