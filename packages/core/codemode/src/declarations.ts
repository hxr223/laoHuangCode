import { mapCodeModeToolNames } from "./identifier.ts";
import { validateCodeModeGlobals } from "./globals.ts";
import type { CodeModeGlobal, CodeModeJsonSchema, CodeModeTool } from "./types.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LINE_TERMINATORS = /[\r\n\u2028\u2029]/g;

function literal(value: unknown): string {
  return (JSON.stringify(value) ?? "unknown").replace(/[\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16)}`);
}

function key(name: string): string { return IDENTIFIER.test(name) ? name : literal(name); }

function comment(description?: string): string {
  return description ? `/** ${description.replaceAll("*/", "*\\/").replace(LINE_TERMINATORS, " ")} */\n` : "";
}

/** Bounded JSON Schema rendering; references are local and never fetch remote content. */
export function schemaToType(schema: CodeModeJsonSchema, options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? 16000;
  const resolving = new Set<string>();
  let expansions = 0;
  let nodes = 0;
  const union = (types: readonly string[]) => types.includes("unknown") ? "unknown" : [...new Set(types)].join(" | ") || "never";
  const render = (value: unknown, depth: number): string => {
    if (++nodes > 4096 || depth > 64) return "unknown";
    if (value === false) return "never";
    if (value === true || !value || typeof value !== "object" || Array.isArray(value)) return "unknown";
    const item = value as Record<string, unknown>;
    let result: string;
    if (typeof item.$ref === "string") {
      const ref = item.$ref;
      if (resolving.has(ref) || expansions >= 32 || ref !== "#" && !ref.startsWith("#/")) return "unknown";
      let target: unknown = schema;
      try {
        for (const part of ref === "#" ? [] : ref.slice(2).split("/")) {
          const name = decodeURIComponent(part).replaceAll("~1", "/").replaceAll("~0", "~");
          if (!target || typeof target !== "object" || !Object.hasOwn(target, name)) return "unknown";
          target = (target as Record<string, unknown>)[name];
        }
      } catch { return "unknown"; }
      resolving.add(ref); expansions++;
      try { return render(target, depth + 1); } finally { resolving.delete(ref); }
    }
    if (Object.hasOwn(item, "const")) result = literal(item.const);
    else if (Array.isArray(item.enum)) result = union(item.enum.map(literal));
    else if (Array.isArray(item.anyOf) || Array.isArray(item.oneOf)) {
      const variants = (Array.isArray(item.anyOf) ? item.anyOf : item.oneOf) as unknown[];
      result = union(variants.map(part => render(part, depth + 1)));
    }
    else if (Array.isArray(item.allOf)) result = item.allOf.map(part => `(${render(part, depth + 1)})`).join(" & ") || "unknown";
    else if (Array.isArray(item.type)) result = union(item.type.map(type => render({ ...item, type }, depth + 1)));
    else {
      const type = item.type ?? (item.properties !== undefined || item.required !== undefined || item.additionalProperties !== undefined ? "object" : item.items !== undefined || item.prefixItems !== undefined ? "array" : undefined);
      switch (type) {
        case "string": result = "string"; break;
        case "boolean": result = "boolean"; break;
        case "null": result = "null"; break;
        case "integer": case "number": result = "number"; break;
        case "array": {
          const tuple = Array.isArray(item.prefixItems) ? item.prefixItems : Array.isArray(item.items) ? item.items : undefined;
          result = tuple ? `[${tuple.map(part => render(part, depth + 1)).join(", ")}]` : `Array<${render(item.items, depth + 1)}>`;
          break;
        }
        case "object": {
          const properties = item.properties && typeof item.properties === "object" && !Array.isArray(item.properties) ? item.properties as Record<string, unknown> : {};
          const names = Object.keys(properties).sort();
          if (names.length > 4096) return "unknown";
          const required = new Set(Array.isArray(item.required) ? item.required : []);
          const members = names.map(name => {
            const property = properties[name];
            const description = property && typeof property === "object" && "description" in property && typeof property.description === "string" ? comment(property.description) : "";
            return `${description}${key(name)}${required.has(name) ? "" : "?"}: ${render(property, depth + 1)};`;
          });
          if (item.additionalProperties !== undefined && item.additionalProperties !== false) members.push(`[key: string]: ${render(item.additionalProperties, depth + 1)};`);
          else if (!names.length && item.additionalProperties === undefined) members.push("[key: string]: unknown;");
          result = `{ ${members.join(" ")} }`;
          break;
        }
        default: result = "unknown";
      }
    }
    return result.length > maxChars ? "unknown" : result;
  };
  try { return render(schema, 0); } catch { return "unknown"; }
}

type ToolDescription = Pick<CodeModeTool, "name" | "description" | "inputSchema" | "outputSchema">;

function signature(tool: ToolDescription, name: string): string {
  const input = tool.inputSchema === undefined ? "unknown" : schemaToType(tool.inputSchema);
  const output = tool.outputSchema === undefined ? "unknown" : schemaToType(tool.outputSchema);
  return `${key(name)}(args: ${input}): Promise<${output}>;`;
}

export function renderToolSample(tool: ToolDescription): string {
  return `${comment(tool.description)}declare const tools: { ${signature(tool, tool.name)} };`;
}

export function renderDeclarations(options: { tools?: readonly CodeModeTool[]; globals?: readonly CodeModeGlobal[] }): string {
  validateCodeModeGlobals(options.globals ?? []);
  const sections: string[] = [];
  const tools = options.tools ?? [];
  const mapping = mapCodeModeToolNames(tools);
  if (tools.length) sections.push(`declare const tools: {\n${tools.map((tool, index) => {
    const name = mapping[index]!.jsName;
    return comment(tool.description) + signature(tool, name) + (name === tool.name ? "" : `\n${signature(tool, tool.name)}`);
  }).join("\n")}\n};`);
  const namespaces = new Map<string, string[]>();
  for (const global of options.globals ?? []) {
    const parts = global.name.split(".");
    if (parts.length > 2 || parts.some(part => !IDENTIFIER.test(part))) throw new Error("Invalid Code Mode global name");
    const input = global.inputSchema === undefined ? "unknown" : schemaToType(global.inputSchema);
    const output = global.outputSchema === undefined ? "unknown" : schemaToType(global.outputSchema);
    const args = global.spread ? `...args: ${input.startsWith("[") || input.startsWith("Array<") ? input : "unknown[]"}` : `args: ${input}`;
    const declaration = `${parts.at(-1)}(${args}): Promise<${output}>;`;
    if (parts.length === 1) sections.push(`${comment(global.description)}declare function ${declaration}`);
    else {
      const members = namespaces.get(parts[0]!) ?? [];
      members.push(comment(global.description) + declaration);
      namespaces.set(parts[0]!, members);
    }
  }
  for (const [namespace, members] of namespaces) sections.push(`declare const ${namespace}: {\n${members.join("\n")}\n};`);
  return sections.join("\n\n");
}
