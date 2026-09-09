import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { privateRedirectFetch } from "../packages/core/mcp/src/transports.ts";

async function server(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (!address || typeof address === "string") throw new Error("listen failed");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => { instance.close(() => resolve()); instance.closeAllConnections(); }) };
}

test("cross-origin redirects strip authorization, cookies and configured private headers", async () => {
  let received: IncomingMessage["headers"] = {};
  const target = await server((req, res) => { received = req.headers; res.end("done"); });
  const source = await server((_req, res) => res.writeHead(307, { location: target.url }).end());
  try {
    const result = await privateRedirectFetch(fetch, ["X-Private"])(source.url, { headers: { Authorization: "Bearer fixture", Cookie: "fixture", "X-Private": "fixture", "X-Public": "kept" } });
    assert.equal(await result.text(), "done");
    assert.equal(received.authorization, undefined); assert.equal(received.cookie, undefined); assert.equal(received["x-private"], undefined);
    assert.equal(received["x-public"], "kept");
  } finally { await source.close(); await target.close(); }
});

test("same-origin redirects preserve headers and incoming Request cancellation", async () => {
  const target = await server((req, res) => {
    if (req.url === "/hang") return;
    if (req.url === "/next") { res.end(req.headers.authorization); return; }
    res.writeHead(302, { location: "/next" }).end();
  });
  try {
    const wrapped = privateRedirectFetch(fetch, []);
    assert.equal(await (await wrapped(target.url, { headers: { Authorization: "Bearer fixture" } })).text(), "Bearer fixture");
    const signal = AbortSignal.timeout(20);
    await assert.rejects(wrapped(new Request(`${target.url}/hang`, { signal })));
  } finally { await target.close(); }
});
