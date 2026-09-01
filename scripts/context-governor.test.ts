import assert from "node:assert/strict";
import test from "node:test";

import { ModelError, type ModelMessage } from "@laohuang/llm";
import {
  ContextGovernor,
  DefaultTokenEstimator,
  calculateModelBudget,
  fingerprintContextPart,
  normalizeProviderUsage,
  type UsageAnchor,
} from "@laohuang/session-context";
import type { SessionEntry } from "@laohuang/session-store";

test("token estimator deterministically measures text, messages, tool calls, results, and schemas", () => {
  const estimator = new DefaultTokenEstimator();
  assert.equal(estimator.estimateText("abcd"), 1);
  assert.equal(estimator.estimateText("你好"), 2);
  assert.equal(estimator.estimateMessages([{ role: "user", content: "abcd" }]), 9);
  assert.equal(estimator.estimateMessages([assistantTool(1, "call-1").payload.message]), 12);
  assert.equal(estimator.estimateMessages([toolResult(2, "call-1").payload.message]), 9);
  assert.equal(
    estimator.estimateTools([
      {
        name: "read",
        description: "Read file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        promptGuidelines: [],
      },
    ]),
    estimator.estimateTools([
      {
        description: "Read file",
        name: "read",
        promptGuidelines: [],
        parameters: { properties: { path: { type: "string" } }, type: "object" },
      },
    ]),
  );
});

test("token estimator uses valid provider anchors and invalidates on route or fingerprint changes", () => {
  const estimator = new DefaultTokenEstimator();
  const entries = [user(1, "anchored"), user(2, "tail")];
  const anchor: UsageAnchor = {
    throughEntryId: "e1",
    throughSeq: 1,
    contextTokens: 100,
    provider: "pi-ai",
    model: "gpt-test",
    systemFingerprint: "system",
    projectInstructionsFingerprint: "project",
    toolsFingerprint: "tools",
  };

  assert.deepEqual(
    estimator.measure({
      messages: entries.map((entry) => entry.payload.message),
      tools: [],
      entries,
      anchor,
      provider: "pi-ai",
      model: "gpt-test",
      systemFingerprint: "system",
      projectInstructionsFingerprint: "project",
      toolsFingerprint: "tools",
    }),
    {
      totalTokens: 109,
      anchorTokens: 100,
      trailingTokens: 9,
      source: "provider_usage",
    },
  );

  const invalid = estimator.measure({
    messages: entries.map((entry) => entry.payload.message),
    tools: [],
    entries,
    anchor,
    provider: "other",
    model: "gpt-test",
    systemFingerprint: "system",
    projectInstructionsFingerprint: "project",
    toolsFingerprint: "tools",
  });
  assert.equal(invalid.source, "estimated");
  assert.equal(invalid.anchorTokens, 0);
});

test("provider usage normalization includes cache tokens and does not double-count reasoning", () => {
  assert.equal(
    normalizeProviderUsage({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      reasoningTokens: 8,
    }),
    37,
  );
});

test("model budget formulas work for large context windows", () => {
  assert.deepEqual(calculateModelBudget({
    budget: { contextWindow: 128_000, maxOutputTokens: 8_000 },
    policy: defaultPolicy(),
  }), {
    hardInputLimit: 120_000,
    safetyTokens: 6_400,
    autoTrigger: 102_400,
    retainTokens: 20_480,
  });
  assert.equal(calculateModelBudget({
    budget: { contextWindow: 200_000, maxOutputTokens: 8_000 },
    policy: defaultPolicy(),
  }).autoTrigger, 160_000);
  assert.equal(calculateModelBudget({
    budget: { contextWindow: 1_000_000, maxOutputTokens: 16_000 },
    policy: defaultPolicy(),
  }).retainTokens, 160_000);
});

test("manual compaction with no summarizable entries fails without writing a checkpoint", async () => {
  let summarizeCalls = 0;
  let appendCalls = 0;
  const governor = new ContextGovernor({
    summarize: async () => {
      summarizeCalls += 1;
      return { summary: "should not run", inputTokens: 1, outputTokens: 1 };
    },
    appendCompaction: (payload) => {
      appendCalls += 1;
      return { ...base(2), entryType: "compaction", payload } as SessionEntry;
    },
  });

  await assert.rejects(
    governor.compact({
      entries: [system(1, "system")],
      currentProvider: "pi-ai",
      currentModel: "gpt-test",
      tools: [],
      budget: { contextWindow: 100, maxOutputTokens: 20 },
      policy: defaultPolicy(),
      trigger: "manual",
    }),
    /No messages to compact in current history\./,
  );

  assert.equal(summarizeCalls, 0);
  assert.equal(appendCalls, 0);
});

test("context governor compacts before over-threshold requests and records checkpoints", async () => {
  const checkpoints: string[] = [];
  const governor = new ContextGovernor({
    summarize: async () => ({ summary: "summary", inputTokens: 30, outputTokens: 5 }),
    appendCompaction: (payload) => {
      checkpoints.push(payload.summary);
      return { ...base(99), entryType: "compaction", payload } as SessionEntry;
    },
  });
  const prepared = await governor.prepare({
    entries: [system(1, "system"), user(2, "x".repeat(300)), user(3, "tail")],
    currentProvider: "pi-ai",
    currentModel: "gpt-test",
    tools: [],
    budget: { contextWindow: 100, maxOutputTokens: 20 },
    policy: { ...defaultPolicy(), thresholdRatio: 0.5, retainTokens: 8 },
  });

  assert.equal(checkpoints.length, 1);
  assert.equal(prepared.compacted, true);
});

test("context governor keeps old context if summary fails and supersedes old checkpoints on second compaction", async () => {
  const appended: string[] = [];
  const governor = new ContextGovernor({
    summarize: async () => {
      if (appended.length === 0) {
        throw new Error("summary failed");
      }
      return { summary: "second", inputTokens: 20, outputTokens: 3 };
    },
    appendCompaction: (payload) => {
      appended.push(payload.summary);
      return { ...base(100 + appended.length), entryType: "compaction", payload } as SessionEntry;
    },
  });
  const entries = [system(1, "system"), user(2, "a".repeat(100)), user(3, "tail")];
  await assert.rejects(
    governor.compact({
      entries,
      currentProvider: "pi-ai",
      currentModel: "gpt-test",
      tools: [],
      budget: { contextWindow: 100, maxOutputTokens: 20 },
      policy: { ...defaultPolicy(), retainTokens: 1 },
      trigger: "manual",
    }),
    /summary failed/,
  );
  appended.push("prime");
  const result = await governor.compact({
    entries: [
      ...entries,
      {
        ...base(3),
        entryType: "compaction",
        payload: {
          summary: "old",
          summarizedFromSeq: 2,
          summarizedThroughSeq: 2,
          retainedFromSeq: 2,
          tokensBefore: 50,
          retainedTokens: 10,
          summaryInputTokens: 10,
          summaryOutputTokens: 5,
          provider: "pi-ai",
          model: "gpt-test",
          trigger: "manual",
        },
      } as SessionEntry,
    ],
    currentProvider: "pi-ai",
    currentModel: "gpt-test",
    tools: [],
    budget: { contextWindow: 100, maxOutputTokens: 20 },
    policy: { ...defaultPolicy(), retainTokens: 1 },
    trigger: "manual",
  });
  assert.equal(result.entry.payload.supersedesCompactionId, "e3");
});

test("context governor forces provider-overflow compaction and retries only once", async () => {
  let calls = 0;
  let compactions = 0;
  const governor = new ContextGovernor({
    summarize: async () => ({ summary: "overflow summary", inputTokens: 10, outputTokens: 2 }),
    appendCompaction: (payload) => {
      compactions += 1;
      return { ...base(50 + compactions), entryType: "compaction", payload } as SessionEntry;
    },
  });
  await assert.rejects(
    governor.completeWithOverflowRecovery(
      {
        entries: [system(1, "system"), user(2, "hello")],
        currentProvider: "pi-ai",
        currentModel: "gpt-test",
        tools: [],
        budget: { contextWindow: 1_000, maxOutputTokens: 100 },
        policy: defaultPolicy(),
      },
      async () => {
        calls += 1;
        throw new ModelError("too many tokens", {
          kind: "context_overflow",
          hadDelta: false,
        });
      },
    ),
    ModelError,
  );
  assert.equal(calls, 2);
  assert.equal(compactions, 1);
});

function defaultPolicy() {
  return {
    auto: true,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    maxSummaryTokens: 8192,
    safetyRatio: 0.05,
  } as const;
}

function base(seq: number): Omit<SessionEntry, "entryType" | "payload"> {
  return {
    schemaVersion: 1,
    sessionId: "session",
    seq,
    id: `e${seq}`,
    timestamp: "2026-08-31T00:00:00.000Z",
    kind: "entry",
  } as Omit<SessionEntry, "entryType" | "payload">;
}

function system(seq: number, content: string): SessionEntry {
  return {
    ...base(seq),
    entryType: "system_context",
    payload: { message: { role: "system", content }, cwd: "/tmp/project" },
  } as SessionEntry;
}

function user(seq: number, content: string): Extract<SessionEntry, { readonly entryType: "user_message" }> {
  return {
    ...base(seq),
    entryType: "user_message",
    payload: {
      message: { role: "user", content },
      inputEventIds: [],
      source: "direct",
    },
  } as Extract<SessionEntry, { readonly entryType: "user_message" }>;
}

function assistantTool(seq: number, callId: string): Extract<SessionEntry, { readonly entryType: "assistant_message" }> {
  return {
    ...base(seq),
    entryType: "assistant_message",
    payload: {
      message: {
        role: "assistant",
        provider: "pi-ai",
        model: "gpt-test",
        content: [{ type: "tool-call", call: { id: callId, name: "read", arguments: { path: "a" } } }],
      },
      requestId: "request-1",
      finishReason: "tool-calls",
    },
  } as Extract<SessionEntry, { readonly entryType: "assistant_message" }>;
}

function toolResult(seq: number, callId: string): Extract<SessionEntry, { readonly entryType: "tool_result" }> {
  return {
    ...base(seq),
    entryType: "tool_result",
    payload: {
      message: { role: "tool-result", toolCallId: callId, toolName: "read", content: "ok", isError: false },
      requestId: "request-1",
      recovered: false,
    },
  } as Extract<SessionEntry, { readonly entryType: "tool_result" }>;
}
