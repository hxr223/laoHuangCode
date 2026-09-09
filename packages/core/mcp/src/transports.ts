import { dirname, resolve } from "node:path";
import { StreamableHTTPClientTransport, SSEClientTransport } from "@modelcontextprotocol/client";
import type { McpOAuthProvider } from "./auth/provider.ts";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { ResolvedMcpServer } from "./types.ts";
import { resolveSecretValues } from "./config.ts";

export type McpTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;

export function createMcpTransport(options: {
  server: ResolvedMcpServer; projectRoot: string; env: Readonly<Record<string, string | undefined>>;
  provider?: McpOAuthProvider; fetch?: typeof fetch;
}): McpTransport {
  const { config } = options.server;
  if (config.transport === "stdio") {
    return new StdioClientTransport({ command: config.command, args: [...(config.args ?? [])],
      cwd: config.cwd === undefined ? options.projectRoot : resolve(dirname(options.server.sourcePath), config.cwd),
      env: { ...getDefaultEnvironment(), ...resolveSecretValues(config.env, options.env) }, stderr: "ignore" });
  }
  const headers = resolveSecretValues(config.headers, options.env);
  const settings = { requestInit: { headers }, authProvider: options.provider,
    fetch: privateRedirectFetch(options.fetch ?? fetch, Object.keys(headers)) };
  const transport = config.transport === "sse" ? new SSEClientTransport(new URL(config.url), settings)
    : new StreamableHTTPClientTransport(new URL(config.url), settings);
  const provider = options.provider;
  if (provider) {
    if (transport instanceof StreamableHTTPClientTransport) {
      const send = transport.send.bind(transport);
      transport.send = (message, requestOptions) => provider.withAuthContext(() => send(message, requestOptions));
    } else {
      const send = transport.send.bind(transport);
      transport.send = message => provider.withAuthContext(() => send(message));
    }
  }
  return transport;
}

/** Never carry configured credentials to a different origin through redirects. */
export function privateRedirectFetch(base: typeof fetch, privateHeaders: readonly string[]): typeof fetch {
  return async (input, init) => {
    let request = new Request(input, init);
    for (let redirects = 0; redirects <= 10; redirects++) {
      const replay = request.clone();
      const response = await base(request, { redirect: "manual" });
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      await response.body?.cancel();
      const next = new URL(location, request.url);
      if (!["https:", "http:"].includes(next.protocol) || next.username || next.password) throw new Error("Invalid MCP redirect");
      const headers = new Headers(request.headers);
      if (next.origin !== new URL(request.url).origin) {
        for (const key of [...privateHeaders, "authorization", "proxy-authorization", "cookie"]) headers.delete(key);
      }
      const get = response.status === 303 && request.method !== "HEAD" || (response.status === 301 || response.status === 302) && request.method === "POST";
      if (get) { headers.delete("content-type"); headers.delete("content-length"); }
      request = new Request(next, { method: get ? "GET" : request.method, headers, signal: request.signal,
        body: get || request.method === "GET" || request.method === "HEAD" ? undefined : await replay.arrayBuffer() });
    }
    throw new Error("Too many MCP redirects");
  };
}
