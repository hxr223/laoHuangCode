import { auth, type SSEClientTransport, type StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createOAuthCallback } from "./callback.ts";
import { McpOAuthProvider } from "./provider.ts";
import { waitWithSignal } from "../client.ts";

export async function authorizeMcp(options: {
  provider: McpOAuthProvider; transport: SSEClientTransport | StreamableHTTPClientTransport;
  serverUrl: string; showUrl: (url: string) => void; signal: AbortSignal; timeoutMs?: number;
}): Promise<void> {
  const { provider, signal } = options;
  const callback = await createOAuthCallback({ state: provider.state(), timeoutMs: options.timeoutMs ?? 900000, signal });
  try {
    provider.beginLogin(callback.redirectUrl, options.showUrl);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    const result = await auth(provider, { serverUrl: options.serverUrl,
      fetchFn: (input, init) => provider.fetch(input, { ...init, signal: requestSignal }) });
    if (result !== "AUTHORIZED") {
      const params = await waitWithSignal(callback.response, signal);
      if (params.has("error")) throw new Error("MCP authorization was rejected");
      await waitWithSignal(options.transport.finishAuth(params), AbortSignal.any([signal, AbortSignal.timeout(30000)]));
    }
  } finally { provider.endLogin(); await callback.close(); }
}
