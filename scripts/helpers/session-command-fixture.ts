import type {
  ModelAuthStatus,
  ModelCatalog,
  ModelInfo,
  ModelProviderInfo,
  ReasoningEffort,
} from "@laohuang/llm";
import {
  SessionCommands,
  type AgentLike,
  type SessionLike,
} from "../../apps/cli/src/commands.ts";
import type { CommandPresenter } from "../../apps/cli/src/command-presentation.ts";
import { ModelSelector } from "../../apps/cli/src/model-selection.ts";
import type {
  AuthPromptHandler,
  ProviderAuthController,
} from "../../apps/cli/src/provider-auth.ts";

function model(
  provider: string,
  id: string,
  options: {
    readonly reasoning?: boolean;
    readonly supportedReasoningEfforts?: readonly ReasoningEffort[];
  } = {},
): ModelInfo {
  return {
    provider,
    id,
    name: id,
    api: "openai-completions",
    reasoning: options.reasoning ?? false,
    supportedReasoningEfforts: options.supportedReasoningEfforts ?? ["off"],
    input: ["text"],
    contextWindow: 8192,
    maxTokens: 2048,
  };
}

function providerInfo(id: string, verified: boolean): ModelProviderInfo {
  return {
    id,
    name: id,
    authName: `${id} API key`,
    dynamicModels: false,
    verified,
  };
}

export class FakeCatalog implements ModelCatalog {
  providers: readonly ModelProviderInfo[];
  readonly models = new Map<string, readonly ModelInfo[]>();
  readonly refreshCalls: string[] = [];

  constructor(providers: readonly ModelProviderInfo[]) {
    this.providers = providers;
    this.models.set("anthropic", [model("anthropic", "claude-sonnet-4-5")]);
    this.models.set("deepseek", [
      model("deepseek", "deepseek-v4-flash", {
        reasoning: true,
        supportedReasoningEfforts: ["off", "minimal", "low", "medium", "high"],
      }),
      model("deepseek", "deepseek-v4-pro", {
        reasoning: true,
        supportedReasoningEfforts: ["off", "minimal", "low", "medium", "high", "xhigh"],
      }),
    ]);
  }

  listProviders(): readonly ModelProviderInfo[] {
    return this.providers;
  }

  getProvider(provider: string): ModelProviderInfo | undefined {
    return this.providers.find((item) => item.id === provider);
  }

  listModels(provider: string): readonly ModelInfo[] {
    return this.models.get(provider) ?? [];
  }

  async listAvailableModels(provider: string): Promise<readonly ModelInfo[]> {
    return this.listModels(provider);
  }

  getModel(provider: string, id: string): ModelInfo | undefined {
    return this.listModels(provider).find((item) => item.id === id);
  }

  async refresh(provider: string): Promise<void> {
    this.refreshCalls.push(provider);
  }
}

export class FakeProviderAuth
  implements Pick<ProviderAuthController, "status" | "login" | "logout" | "ensureConfigured">
{
  readonly loginCalls: string[] = [];
  readonly logoutCalls: string[] = [];
  readonly ensureConfiguredCalls: Array<{
    readonly provider: string;
    readonly promptIfMissing: boolean;
    readonly hasPrompts: boolean;
  }> = [];
  configured: Set<string>;
  ambientSources: ReadonlyMap<string, string>;

  constructor(
    configured: ReadonlySet<string>,
    ambientSources: ReadonlyMap<string, string> = new Map(),
  ) {
    this.configured = new Set(configured);
    this.ambientSources = ambientSources;
  }

  async status(provider: string): Promise<ModelAuthStatus> {
    const ambientSource = this.ambientSources.get(provider);
    if (ambientSource !== undefined) {
      return { configured: true, source: ambientSource };
    }
    return this.configured.has(provider)
      ? { configured: true, source: "stored credential" }
      : { configured: false };
  }

  async ensureConfigured(
    provider: string,
    options: {
      readonly promptIfMissing: boolean;
      readonly prompts?: AuthPromptHandler;
    },
  ): Promise<boolean> {
    this.ensureConfiguredCalls.push({
      provider,
      promptIfMissing: options.promptIfMissing,
      hasPrompts: options.prompts !== undefined,
    });
    if (this.configured.has(provider)) {
      return true;
    }
    if (!options.promptIfMissing) {
      return false;
    }
    return this.login(provider);
  }

  async login(provider: string): Promise<boolean> {
    this.loginCalls.push(provider);
    this.configured.add(provider);
    return true;
  }

  async logout(provider: string): Promise<void> {
    this.logoutCalls.push(provider);
    this.configured.delete(provider);
  }
}

export class FakeAgent implements AgentLike {
  model: string;
  provider: string;
  baseUrl: string | null;
  messages: unknown[] = [{ role: "system", content: "system prompt" }];
  readonly modelSwitches: Array<{ readonly provider: string; readonly model: string }> = [];
  reasoningEffort: ReasoningEffort = "high";

  constructor(options: { readonly model: string; readonly provider?: string; readonly baseUrl?: string | null }) {
    this.model = options.model;
    this.provider = options.provider ?? "deepseek";
    this.baseUrl = options.baseUrl ?? null;
  }

  switchModel(options: {
    readonly model: string;
    readonly provider: string;
    readonly baseUrl: string | null;
  }): void {
    this.model = options.model;
    this.provider = options.provider;
    this.baseUrl = options.baseUrl;
    this.modelSwitches.push({ provider: options.provider, model: options.model });
  }

  clearHistory(): void {
    this.messages.splice(1);
  }

  setReasoningEffort(effort: ReasoningEffort): void {
    this.reasoningEffort = effort;
  }

  getReasoningEffort(): ReasoningEffort {
    return this.reasoningEffort;
  }
}

export interface SessionCommandFixtureOptions {
  readonly presenter: CommandPresenter;
  readonly providers?: readonly ModelProviderInfo[];
  readonly configured?: ReadonlySet<string>;
  readonly ambientSources?: ReadonlyMap<string, string>;
  readonly agent?: FakeAgent;
  readonly session?: SessionLike | null;
  readonly sessionController?: ConstructorParameters<typeof SessionCommands>[0]["sessionController"];
  readonly onComposerText?: ConstructorParameters<typeof SessionCommands>[0]["onComposerText"];
  readonly onSessionChanged?: ConstructorParameters<typeof SessionCommands>[0]["onSessionChanged"];
}

export interface SessionCommandFixture {
  readonly commands: SessionCommands;
  readonly agent: FakeAgent;
  readonly auth: FakeProviderAuth;
  readonly catalog: FakeCatalog;
}

export function createSessionCommandFixture(
  options: SessionCommandFixtureOptions,
): SessionCommandFixture {
  const catalog = new FakeCatalog(
    options.providers ?? [providerInfo("deepseek", false), providerInfo("anthropic", false)],
  );
  const auth = new FakeProviderAuth(
    options.configured ?? new Set(["deepseek"]),
    options.ambientSources,
  );
  const selector = new ModelSelector({ catalog, providerAuth: auth });
  const agent = options.agent
    ?? new FakeAgent({ model: "deepseek-v4-flash", provider: "deepseek" });
  const commands = new SessionCommands({
    agent,
    selector,
    catalog,
    providerAuth: auth,
    currentConfig: {
      model: "deepseek-v4-flash",
      baseUrl: null,
      provider: "deepseek",
    },
    presenter: options.presenter,
    session: options.session ?? null,
    sessionController: options.sessionController,
    onComposerText: options.onComposerText,
    onSessionChanged: options.onSessionChanged,
    homeDirectory: "/Users/huangxurui",
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  });
  return { commands, agent, auth, catalog };
}
