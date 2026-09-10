import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createGateway } from "./evals/gateway.ts";
import { setTimeout as delay } from "node:timers/promises";

test("gateway reserves its budget after concurrent request bodies finish", async (t) => {
  const gateway = createGateway({
    apiKey: "unused",
    token: "token",
    maxRequests: 1,
    model: "kimi-for-coding",
    offline: true,
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.close());
  const address = gateway.address() as AddressInfo;
  const pending = Array.from({ length: 2 }, () => {
    let finish!: () => void;
    const done = new Promise<number>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path: "/v1/messages",
          method: "POST",
          headers: { "x-api-key": "token", "content-type": "application/json" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.write('{"model":"kimi-for-coding",');
      finish = () => req.end('"messages":[]}');
    });
    return { done, finish };
  });
  await delay(30);
  for (const item of pending) item.finish();
  assert.deepEqual(
    (await Promise.all(pending.map((item) => item.done))).sort(),
    [200, 429],
  );
});
test("gateway rejects arbitrary routes and limits requests while hiding real credentials", async (t) => {
  let receivedKey = "";
  let receivedBody = "";
  const upstream = createServer((req, res) => {
    receivedKey = String(req.headers["x-api-key"]);
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      receivedBody += chunk;
    });
    req.on("end", () => {
      res.setHeader("content-type", "text/event-stream");
      res.end('data: {"type":"message_stop"}\n\n');
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => upstream.close());
  const events: Record<string, unknown>[] = [];
  const gateway = createGateway({
    apiKey: "actual-secret",
    token: "run-token",
    maxRequests: 1,
    model: "kimi-for-coding",
    upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/messages`,
    onRecord: (r) => events.push(r),
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  t.after(() => gateway.close());
  const url = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  assert.equal((await fetch(url + "/other", { method: "POST" })).status, 404);
  assert.equal(
    (await fetch(url + "/v1/messages", { method: "POST" })).status,
    401,
  );
  const request = {
    method: "POST",
    headers: { "x-api-key": "run-token", "content-type": "application/json" },
    body: JSON.stringify({
      model: "kimi-for-coding",
      messages: [],
      max_tokens: 50,
      stream: true,
    }),
  };
  assert.equal((await fetch(url + "/v1/messages", request)).status, 200);
  assert.equal(receivedKey, "actual-secret");
  assert.match(receivedBody, /kimi-for-coding/u);
  assert.equal((await fetch(url + "/v1/messages", request)).status, 429);
  assert.ok(!JSON.stringify(events).includes("actual-secret"));
});
