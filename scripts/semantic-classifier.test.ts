import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SmallModelSemanticClassifier,
  type ChatCompletionRequest,
  type ChatCompletionsClient,
} from "../apps/cli/src/semantic-classifier.ts";

interface CapturedCall {
  request: ChatCompletionRequest;
  options?: { timeout?: number };
}

function fakeClient(body: unknown): {
  client: ChatCompletionsClient;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const client: ChatCompletionsClient = {
    chat: {
      completions: {
        create(request, options) {
          calls.push({ request, options });
          return Promise.resolve({
            choices: [{ message: { content: JSON.stringify(body) } }],
          });
        },
      },
    },
  };
  return { client, calls };
}

test("uses one no-history request and accepts confident json", async () => {
  const { client, calls } = fakeClient({ strategy: "steer", confidence: 0.91 });
  const classifier = new SmallModelSemanticClassifier({
    client,
    model: "router-model",
  });
  const active = { taskId: "task-1", state: "running_model" };
  const event = { payload: { content: "改成另一种实现" } };

  const decision = await classifier.classify(event, active);

  assert.ok(decision);
  assert.equal(decision.strategy, "steer");
  assert.equal(calls.length, 1);
  const messages = calls[0]?.request.messages ?? [];
  assert.equal(messages.length, 2);
  assert.equal(calls[0]?.options?.timeout, 3000);
});

test("low confidence or invalid output falls back", async () => {
  const { client } = fakeClient({ strategy: "follow_up", confidence: 0.2 });
  const classifier = new SmallModelSemanticClassifier({
    client,
    model: "router-model",
  });
  const active = { taskId: "task-1", state: "running_model" };
  const event = { payload: { content: "还有一个想法" } };

  assert.equal(await classifier.classify(event, active), null);
});
