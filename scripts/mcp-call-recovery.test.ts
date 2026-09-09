import assert from "node:assert/strict";
import test from "node:test";
import { ProtocolError, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { callWithRecovery } from "../packages/core/mcp/src/call-recovery.ts";

const network = () => new TypeError("fetch failed");
for (const scenario of ["retry-original", "reconnect", "closed", "exhausted"] as const) {
  test(`bounded recovery: ${scenario}`, async () => {
    const calls: number[] = [];
    let probes = 0, reconnects = 0;
    const result = callWithRecovery({ client: 1, check: () => {},
      call: async client => {
        calls.push(client);
        if (scenario === "closed" && calls.length === 1) throw new SdkError(SdkErrorCode.ConnectionClosed, "closed");
        if (scenario === "exhausted" || calls.length === 1 || scenario === "reconnect" && client === 1) throw network();
        return "ok";
      },
      ping: async () => { probes++; throw new ProtocolError(-32601, "ping unsupported"); },
      reconnect: async () => { reconnects++; return 2; },
    });
    if (scenario === "exhausted") await assert.rejects(result, /fetch failed/);
    else assert.equal(await result, "ok");
    assert.deepEqual(calls, scenario === "closed" ? [1, 2] : scenario === "retry-original" ? [1, 1] : [1, 1, 2]);
    assert.equal(probes, scenario === "closed" ? 0 : 1);
    assert.equal(reconnects, scenario === "retry-original" ? 0 : 1);
  });
}

for (const error of [new ProtocolError(-32602, "bad arguments"), new SdkError(SdkErrorCode.RequestTimeout, "timeout"), new SdkError(SdkErrorCode.InvalidResult, "bad result"), new Error("storage failed"), new DOMException("cancel", "AbortError")]) {
  test(`does not retry ${error.name}: ${error.message}`, async () => {
    let calls = 0;
    await assert.rejects(callWithRecovery({ client: 1, check: () => {}, call: async () => { calls++; throw error; },
      ping: async () => assert.fail("must not probe"), reconnect: async () => assert.fail("must not reconnect") }), value => value === error);
    assert.equal(calls, 1);
  });
}

test("cancellation or binding removal during a failed attempt stops all retries", async () => {
  let valid = true, calls = 0;
  await assert.rejects(callWithRecovery({ client: 1, check: () => { if (!valid) throw new Error("removed"); },
    call: async () => { calls++; valid = false; throw network(); }, ping: async () => assert.fail(), reconnect: async () => assert.fail() }), /removed/);
  assert.equal(calls, 1);
});
