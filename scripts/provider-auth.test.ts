import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApiKeySetupInteraction,
  ModelAuthService,
  ModelAuthStatus,
} from "@laohuang/llm";
import { ModelError } from "@laohuang/llm";
import type { PromptPresentation } from "../apps/cli/src/command-presentation.ts";
import {
  type AuthPromptHandler,
  ProviderAuthController,
} from "../apps/cli/src/provider-auth.ts";
import { RecordingPresenter } from "./helpers/command-presentation-fixture.ts";

class FakeAuthService implements ModelAuthService {
  readonly loginFn: (
    interaction: ApiKeySetupInteraction,
  ) => Promise<ModelAuthStatus>;
  statusValue: ModelAuthStatus = { configured: false };
  loginCalls = 0;

  constructor(
    loginFn: (
      interaction: ApiKeySetupInteraction,
    ) => Promise<ModelAuthStatus>,
  ) {
    this.loginFn = loginFn;
  }

  async status(): Promise<ModelAuthStatus> {
    return this.statusValue;
  }

  loginApiKey(
    _provider: string,
    interaction: ApiKeySetupInteraction,
  ): Promise<ModelAuthStatus> {
    this.loginCalls += 1;
    return this.loginFn(interaction);
  }

  async logout(): Promise<void> {}
}

function presenterPrompts(
  presenter: RecordingPresenter,
  provider: string,
): AuthPromptHandler {
  return {
    prompt: (request) => presenter.prompt({
      id: `auth-${provider}`,
      kind: request.kind,
      message: request.message,
      ...(request.kind === "select"
        ? {
            items: (request.options ?? []).map((item) => ({
              value: item.id,
              label: item.label,
              description: item.description,
            })),
          }
        : {}),
    } as PromptPresentation),
  };
}

test("login routes secret prompts through presenter", async () => {
  const presenter = new RecordingPresenter({ prompts: ["api-secret"] });
  const auth = new FakeAuthService(async (interaction) => {
    assert.equal(await interaction.prompt({
      type: "secret",
      message: "Enter API key",
    }), "api-secret");
    return { configured: true, source: "stored credential" };
  });
  const controller = new ProviderAuthController({ auth });

  const status = await controller.login(
    "deepseek",
    presenterPrompts(presenter, "deepseek"),
  );

  assert.equal(status?.configured, true);
  assert.equal(presenter.promptRequests[0]?.kind, "secret");
  assert.equal(JSON.stringify(presenter).includes("api-secret"), false);
});

test("login routes text and select prompts through presenter models", async () => {
  const presenter = new RecordingPresenter({ prompts: ["account-1", "eu"] });
  const auth = new FakeAuthService(async (interaction) => {
    assert.equal(await interaction.prompt({
      type: "text",
      message: "Enter account",
    }), "account-1");
    assert.equal(await interaction.prompt({
      type: "select",
      message: "Choose region",
      options: [
        { id: "us", label: "US" },
        { id: "eu", label: "EU", description: "Europe" },
      ],
    }), "eu");
    return { configured: true, source: "stored credential" };
  });
  const controller = new ProviderAuthController({ auth });

  const status = await controller.login(
    "gateway",
    presenterPrompts(presenter, "gateway"),
  );

  assert.equal(status?.configured, true);
  assert.deepEqual(presenter.promptRequests, [
    { id: "auth-gateway", kind: "text", message: "Enter account" },
    {
      id: "auth-gateway",
      kind: "select",
      message: "Choose region",
      items: [
        { value: "us", label: "US", description: undefined },
        { value: "eu", label: "EU", description: "Europe" },
      ],
    },
  ]);
});

test("login returns null when any presenter prompt is cancelled", async (t) => {
  for (const kind of ["text", "secret", "select"] as const) {
    await t.test(kind, async () => {
      const auth = new FakeAuthService(async (interaction) => {
        await interaction.prompt(
          kind === "select"
            ? {
                type: "select",
                message: "Choose region",
                options: [{ id: "us", label: "US" }],
              }
            : { type: kind, message: `Enter ${kind}` },
        );
        return { configured: true, source: "stored credential" };
      });
      const controller = new ProviderAuthController({ auth });

      assert.equal(await controller.login("provider", {
        prompt: async () => null,
      }), null);
    });
  }
});

test("login preserves cancellation when the adapter wraps the prompt error", async () => {
  const auth = new FakeAuthService(async (interaction) => {
    try {
      await interaction.prompt({
        type: "secret",
        message: "Enter API key",
      });
    } catch (error) {
      throw new ModelError("pi-ai authentication failed", {
        kind: "retryable",
        cause: error,
      });
    }
    throw new Error("cancelled authentication unexpectedly continued");
  });
  const controller = new ProviderAuthController({ auth });

  assert.equal(await controller.login("deepseek", {
    prompt: async () => null,
  }), null);
});

test("login propagates auth service failures to the command layer", async () => {
  const auth = new FakeAuthService(async () => {
    throw new Error("dynamic catalog refresh failed");
  });
  const controller = new ProviderAuthController({ auth });

  await assert.rejects(
    controller.login("radius", { prompt: async () => "value" }),
    /dynamic catalog refresh failed/,
  );
});

test("ensureConfigured does not prompt when explicit login is required", async () => {
  const auth = new FakeAuthService(async () => ({
    configured: true,
    source: "stored credential",
  }));
  const controller = new ProviderAuthController({ auth });

  assert.equal(
    await controller.ensureConfigured("anthropic", { promptIfMissing: false }),
    false,
  );
  assert.equal(auth.loginCalls, 0);
});

test("ensureConfigured requires prompts before configuring missing credentials", async () => {
  const auth = new FakeAuthService(async () => ({
    configured: true,
    source: "stored credential",
  }));
  const controller = new ProviderAuthController({ auth });

  await assert.rejects(
    controller.ensureConfigured("anthropic", { promptIfMissing: true }),
    /prompt handler/i,
  );
  assert.equal(auth.loginCalls, 0);
});

test("ensureConfigured reports the resulting configured state", async () => {
  const auth = new FakeAuthService(async () => ({
    configured: true,
    source: "stored credential",
  }));
  const controller = new ProviderAuthController({ auth });

  assert.equal(await controller.ensureConfigured("anthropic", {
    promptIfMissing: true,
    prompts: { prompt: async () => "value" },
  }), true);
  assert.equal(auth.loginCalls, 1);

  auth.statusValue = { configured: true, source: "ANTHROPIC_API_KEY" };
  assert.equal(await controller.ensureConfigured("anthropic", {
    promptIfMissing: true,
    prompts: { prompt: async () => null },
  }), true);
  assert.equal(auth.loginCalls, 1);
});
