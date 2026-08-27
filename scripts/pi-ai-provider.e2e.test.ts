import assert from "node:assert/strict";
import test from "node:test";

import {
  ModelRuntime,
  type AssistantModelMessage,
  type ModelPlatform,
  type ModelRuntimeRequest,
} from "@laohuang/llm";
import {
  createPiAiPlatform,
  type ApiKeyCredential,
  type ApiKeyCredentialInfo,
  type ApiKeyCredentialStoreLike,
  type ModelCatalogStoreLike,
  type StoredModelCatalogEntry,
} from "@laohuang/llm-pi-ai";
import { EXCLUDED_PROVIDER_IDS } from "../apps/cli/src/provider-policy.ts";

const enabled = process.env["LAOHUANG_RUN_PROVIDER_E2E"] === "1";
const provider = process.env["LAOHUANG_E2E_PROVIDER"];
const model = process.env["LAOHUANG_E2E_MODEL"];

class EmptyCredentials implements ApiKeyCredentialStoreLike {
  async read(_providerId: string): Promise<undefined> {
    return undefined;
  }

  async list(): Promise<readonly ApiKeyCredentialInfo[]> {
    return [];
  }

  async modify(
    _providerId: string,
    fn: (
      current: ApiKeyCredential | undefined,
    ) => Promise<ApiKeyCredential | undefined>,
  ): Promise<ApiKeyCredential | undefined> {
    return fn(undefined);
  }

  async delete(_providerId: string): Promise<void> {}
}

class EmptyCatalogStore implements ModelCatalogStoreLike {
  async read(_providerId: string): Promise<undefined> {
    return undefined;
  }

  async write(
    _providerId: string,
    _entry: StoredModelCatalogEntry,
  ): Promise<void> {}

  async delete(_providerId: string): Promise<void> {}
}

async function createEnvironmentBackedTestPlatform(): Promise<ModelPlatform> {
  return createPiAiPlatform({
    credentials: new EmptyCredentials(),
    modelCatalogStore: new EmptyCatalogStore(),
    excludedProviderIds: EXCLUDED_PROVIDER_IDS,
    verifiedProviderIds: new Set(),
  });
}

function toolRequest(providerId: string, modelId: string): ModelRuntimeRequest {
  return {
    provider: providerId,
    model: modelId,
    messages: [
      {
        role: "system",
        content: "Use the supplied tool. Do not answer from memory.",
      },
      { role: "user", content: "Call read_fixture for fixture.txt." },
    ],
    tools: [{
      name: "read_fixture",
      description: "Read one named fixture",
      parameters: {
        type: "object",
        properties: { path: { type: "string", const: "fixture.txt" } },
        required: ["path"],
        additionalProperties: false,
      },
      promptGuidelines: [],
    }],
  };
}

function toolResultRequest(
  providerId: string,
  modelId: string,
  assistant: AssistantModelMessage,
): ModelRuntimeRequest {
  const call = assistant.content.find((block) => block.type === "tool-call");
  assert.ok(call && call.type === "tool-call");
  return {
    provider: providerId,
    model: modelId,
    messages: [
      {
        role: "system",
        content: "Use the supplied tool. Do not answer from memory.",
      },
      { role: "user", content: "Call read_fixture for fixture.txt." },
      assistant,
      {
        role: "tool-result",
        toolCallId: call.call.id,
        toolName: call.call.name,
        content: "fixture-value-7429",
        isError: false,
      },
    ],
    tools: [],
  };
}

function dsmlEnvelopePattern(): RegExp {
  const tag = `tool_${"calls"}`;
  return new RegExp(
    `^<｜｜DSML｜｜${tag}>\\s*<｜｜DSML｜｜invoke\\b[\\s\\S]*` +
      `<\\/｜｜DSML｜｜invoke>\\s*<\\/｜｜DSML｜｜${tag}>$`,
  );
}

test(
  "configured provider performs native tool call and consumes its result",
  { skip: enabled ? false : "set LAOHUANG_RUN_PROVIDER_E2E=1 to run provider e2e" },
  async () => {
    assert.ok(provider, "LAOHUANG_E2E_PROVIDER is required");
    assert.ok(model, "LAOHUANG_E2E_MODEL is required");
    assert.ok(!EXCLUDED_PROVIDER_IDS.has(provider), `${provider} is excluded`);

    const platform = await createEnvironmentBackedTestPlatform();
    const status = await platform.auth.status(provider);
    assert.equal(status.configured, true, `${provider} environment auth is missing`);
    await platform.catalog.refresh(provider);
    assert.ok(
      platform.catalog.getModel(provider, model),
      `${provider}/${model} is unknown`,
    );
    const runtime = new ModelRuntime(platform.adapter);

    const first = await runtime.complete(toolRequest(provider, model));
    const calls = first.message.content.filter((block) => block.type === "tool-call");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.call.name, "read_fixture");

    const final = await runtime.complete(
      toolResultRequest(provider, model, first.message),
    );
    const text = final.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    assert.match(text, /fixture-value-7429/);
    assert.doesNotMatch(text.trim(), dsmlEnvelopePattern());
  },
);
