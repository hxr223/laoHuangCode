export const MCP_MAX_LIST_PAGES = 64;
export const MCP_MAX_TOOLS = 10000;
export const MCP_MAX_CATALOG_BYTES = 16 * 1024 * 1024;

export function validateCatalogSize(tools: readonly unknown[]): void {
  if (tools.length > MCP_MAX_TOOLS || Buffer.byteLength(JSON.stringify(tools), "utf8") > MCP_MAX_CATALOG_BYTES) {
    throw new Error("MCP catalog exceeds limits");
  }
}
