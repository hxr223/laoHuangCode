import assert from "node:assert/strict";
import test from "node:test";

import type {
  ApiKeySetupInteraction,
  ModelAuthService,
  ModelAuthStatus,
} from "@laohuang/llm";
import { ProviderAuthController } from "../apps/cli/src/provider-auth.ts";
import { RecordingPresenter } from "./helpers/command-presentation-fixture.ts";

class FakeAuthService implements ModelAuthService {
  readonly loginFn: (
    interaction: ApiKeySetupInteraction,
  ) => Promise<ModelAuthStatus>;

  constructor(
    loginFn: (
      interaction: ApiKeySetupInteraction,
    ) => Promise<ModelAuthStatus>,
  ) {
    this.loginFn = loginFn;
  }

  async status(): Promise<ModelAuthStatus> {
    return { configured: false };
  }

  loginApiKey(
    _provider: string,
    interaction: ApiKeySetupInteraction,
  ): Promise<ModelAuthStatus> {
    return this.loginFn(interaction);
  }

  async logout(): Promise<void> {}
}

test("api-key controller routes secret, text, and select prompts", async () => {
  const inputs = ["account-1", "2"];
  const secrets = ["secret-1"];
  const outputs: string[] = [];
  const auth = new FakeAuthService(async (interaction) => {
    assert.equal(await interaction.prompt({
      type: "secret",
      message: "Enter key",
    }), "secret-1");
    assert.equal(await interaction.prompt({
      type: "text",
      message: "Enter account",
    }), "account-1");
    assert.equal(await interaction.prompt({
      type: "select",
      message: "Choose region",
      options: [
        { id: "us", label: "US" },
        { id: "eu", label: "EU" },
      ],
    }), "eu");
    return { configured: true, source: "stored credential" };
  });
  const controller = new ProviderAuthController({
    auth,
    input: async () => inputs.shift()!,
    secretInput: async () => secrets.shift()!,
    output: (message) => outputs.push(message),
  });

  assert.equal(await controller.login("cloudflare-ai-gateway"), true);
  assert.ok(!outputs.join("\n").includes("secret-1"));
});

test("provider authentication retains its command presentation port", () => {
  const presenter = new RecordingPresenter();
  const controller = new ProviderAuthController({
    auth: new FakeAuthService(async () => ({ configured: true })),
    input: async () => "",
    secretInput: async () => "",
    output: () => {},
    presenter,
  });

  assert.equal(controller.presenter, presenter);
});

test("cancelled and invalid setup prompts do not report login success", async () => {
  const auth = new FakeAuthService(async (interaction) => {
    await interaction.prompt({ type: "secret", message: "Enter key" });
    return { configured: true, source: "stored credential" };
  });
  const cancelled = new ProviderAuthController({
    auth,
    input: async () => "",
    secretInput: async () => {
      const error = new Error("Prompt cancelled");
      error.name = "PromptCancelledError";
      throw error;
    },
    output: () => {},
  });
  assert.equal(await cancelled.login("deepseek"), false);

  const invalidSelectAuth = new FakeAuthService(async (interaction) => {
    await interaction.prompt({
      type: "select",
      message: "Choose region",
      options: [{ id: "us", label: "US" }],
    });
    return { configured: true, source: "stored credential" };
  });
  const invalid = new ProviderAuthController({
    auth: invalidSelectAuth,
    input: async () => "2",
    secretInput: async () => "",
    output: () => {},
  });
  assert.equal(await invalid.login("provider"), false);
});

test("auth service failures are reported without masquerading as cancellation", async () => {
  const outputs: string[] = [];
  const auth = new FakeAuthService(async () => {
    throw new Error("dynamic catalog refresh failed");
  });
  const controller = new ProviderAuthController({
    auth,
    input: async () => "",
    secretInput: async () => "",
    output: (message) => outputs.push(message),
  });

  assert.equal(await controller.login("radius"), false);
  assert.deepEqual(outputs, [
    "Login failed for radius: dynamic catalog refresh failed",
  ]);
});

test("ensureConfigured can require an explicit slash-command login", async () => {
  let loginCalls = 0;
  const outputs: string[] = [];
  const auth = new FakeAuthService(async () => {
    loginCalls += 1;
    return { configured: true, source: "stored credential" };
  });
  const controller = new ProviderAuthController({
    auth,
    input: async () => "",
    secretInput: async () => "",
    output: (message) => outputs.push(message),
  });

  assert.equal(
    await controller.ensureConfigured("anthropic", { promptIfMissing: false }),
    false,
  );
  assert.equal(loginCalls, 0);
  assert.deepEqual(outputs, [
    "No credentials configured for anthropic. Run /login anthropic first.",
  ]);
});
