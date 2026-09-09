import { createHash } from "node:crypto";
import type { ToolSpec } from "../index.ts";

export interface LoadedTool {
  readonly version: string;
  readonly spec: ToolSpec;
}

export interface ToolCatalogState {
  readonly mode: "full" | "deferred";
  readonly tools: Readonly<Record<string, string>>;
}

/** Structure supplied by the history owner; this package does not import LLM types. */
export interface ToolSelectionRecord {
  readonly toolDefinitions?: readonly LoadedTool[];
  readonly toolCatalog?: ToolCatalogState;
}

export function canonicalToolJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  });
}

export function toolVersion(spec: ToolSpec): string {
  return createHash("sha256").update(canonicalToolJson({
    name: spec.name, description: spec.description, parameters: spec.parameters, catalog: spec.catalog,
  })).digest("hex");
}

export function toolSearchText(spec: ToolSpec): string {
  const parts = [spec.name, spec.description, spec.catalog?.source ?? "", spec.catalog?.originalName ?? ""];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 32 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    const record = value as Record<string, unknown>;
    if (typeof record.description === "string") parts.push(record.description);
    if (record.properties && typeof record.properties === "object") {
      parts.push(...Object.keys(record.properties));
      for (const property of Object.values(record.properties)) visit(property, depth + 1);
    }
    for (const key of ["items", "additionalProperties", "anyOf", "oneOf", "allOf", "$defs", "definitions"]) {
      if (key === "$defs" || key === "definitions") {
        const definitions = record[key];
        if (definitions && typeof definitions === "object") for (const child of Object.values(definitions)) visit(child, depth + 1);
      } else visit(record[key], depth + 1);
    }
  };
  visit(spec.parameters, 0);
  return parts.join(" ");
}
