import type { CodeModeTool } from "./types.ts";

export function toCodeModeIdentifier(name: string): string {
  let result = "";
  for (const char of name) result += (result === "" ? /^[A-Za-z_$]$/ : /^[A-Za-z0-9_$]$/).test(char) ? char : "_";
  return result || "_";
}

/** Original names have priority; aliases never make another original unreachable. */
export function mapCodeModeToolNames(tools: readonly Pick<CodeModeTool, "name" | "description">[]): { name: string; jsName: string; description?: string }[] {
  const originals = new Set(tools.map(tool => tool.name));
  if (originals.size !== tools.length) throw new Error("Duplicate Code Mode tool name");
  const aliases = new Set<string>();
  return tools.map(tool => {
    const alias = toCodeModeIdentifier(tool.name);
    const jsName = originals.has(alias) && alias !== tool.name || aliases.has(alias) ? tool.name : alias;
    aliases.add(jsName);
    return { name: tool.name, jsName, ...(tool.description === undefined ? {} : { description: tool.description }) };
  });
}
