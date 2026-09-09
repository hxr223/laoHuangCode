import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

export async function createOAuthCallback(options: { state: string; signal?: AbortSignal; timeoutMs: number }): Promise<{
  redirectUrl: URL; response: Promise<URLSearchParams>; close(): Promise<void>;
}> {
  options.signal?.throwIfAborted();
  let accept!: (value: URLSearchParams) => void;
  let reject!: (error: Error) => void;
  let settled = false;
  const response = new Promise<URLSearchParams>((resolve, fail) => { accept = resolve; reject = fail; });
  void response.catch(() => {});
  const server = createServer((request, reply) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const actual = Buffer.from(url.searchParams.get("state") ?? "");
    const expected = Buffer.from(options.state);
    if (request.method !== "GET" || url.pathname !== "/callback") { reply.writeHead(404).end(); return; }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { reply.writeHead(400).end("Invalid OAuth state"); return; }
    if (settled) { reply.writeHead(410).end(); return; }
    if (!url.searchParams.has("code") && !url.searchParams.has("error")) { reply.writeHead(400).end(); return; }
    settled = true;
    clearTimeout(timer);
    reply.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Authorization received. Return to laohuang.");
    accept(url.searchParams);
  });
  await new Promise<void>((resolve, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Cannot bind OAuth callback");
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    if (!settled) { settled = true; reject(new Error("OAuth authorization cancelled")); }
    closing = new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    return closing;
  };
  const onAbort = () => { void close(); };
  const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error("OAuth authorization timed out")); } void close(); }, options.timeoutMs);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  return { redirectUrl: new URL(`http://127.0.0.1:${address.port}/callback`), response, close };
}
