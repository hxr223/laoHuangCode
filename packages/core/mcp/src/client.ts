import { Client } from "@modelcontextprotocol/client";
import type { McpServerConfig } from "./types.ts";
import { MCP_MAX_LIST_PAGES } from "./catalog-limits.ts";

export function createMcpClient(config: McpServerConfig, version: string, changed: () => void): Client {
  const protocol = config.protocol ?? (config.transport === "sse" ? "legacy" : "auto");
  return new Client({ name: "laohuang", version }, {
    versionNegotiation: { mode: protocol === "2026-07-28" ? { pin: protocol } : protocol,
      probe: { timeoutMs: config.probeTimeoutMs ?? 5000, maxRetries: 0 } },
    listMaxPages: MCP_MAX_LIST_PAGES,
    listChanged: { tools: { autoRefresh: false, debounceMs: 50, onChanged: changed } },
  });
}

export function waitWithSignal<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}
