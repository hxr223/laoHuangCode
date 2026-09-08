/** Command-line entry and concrete composition for laohuang. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CodingAgent } from "@laohuang/agent-runtime";
import { ModelRuntime, type ModelCatalog, type ModelMessage } from "@laohuang/llm";
import {
  COMPACTION_SYSTEM_PROMPT,
  ContextBuilder,
  ContextGovernor,
  DefaultTokenEstimator,
  type BuildContextInput,
  type ConversationHistory,
} from "@laohuang/session-context";
import { projectTranscript } from "@laohuang/session-store";
import { createPiAiPlatform } from "@laohuang/llm-pi-ai";
import {
  ConfigManager,
  CredentialStore,
  ModelCatalogStore,
  defaultConfigPath,
  type Config,
} from "@laohuang/local-config";
import {
  EventProjector,
  makeCancelIntent,
} from "@laohuang/runtime-protocol";
import { findProjectRoot } from "@laohuang/project-instructions";
import { AgentSession, SessionRecorder, routeHumanIntent } from "@laohuang/session-runtime";
import { PlainEventSink, StdTerminalDriver, TerminalUI } from "@laohuang/tui";
import { ToolRegistry, type ToolSpec } from "@laohuang/tools";
import { createFileToolDefinitions } from "@laohuang/tool-fs";
import { getHomeDirectory } from "@laohuang/local-paths";
import { createBashToolDefinition, resolveBashPath } from "@laohuang/tool-bash";

import {
  SessionCommands,
  type CommandResult,
  type QueueStatus,
} from "./commands.ts";
import type {
  CommandPresenter,
  PromptPresentation,
} from "./command-presentation.ts";
import {
  ModelSelector,
  type InputFn as PromptFn,
  type ModelSelection,
} from "./model-selection.ts";
import { PlainCommandPresenter } from "./plain-command-presenter.ts";
import {
  ProviderAuthController,
  type AuthPromptHandler,
} from "./provider-auth.ts";
import {
  EXCLUDED_PROVIDER_IDS,
  VERIFIED_PROVIDER_IDS,
} from "./provider-policy.ts";
import { SmallModelSemanticClassifier } from "./semantic-classifier.ts";
import { TerminalCommandPresenter } from "./terminal-command-presenter.ts";
import {
  CliUsageError,
  HELP,
  USAGE,
  parseArgs,
  type ParseResult,
} from "./args.ts";
import { SessionController } from "./session-controller.ts";
import {
  defaultInputFn,
  defaultSecretInputFn,
  errorMessage,
  runPlainSessionRepl,
  runSessionRepl,
  runTerminalUi,
  supportsTerminalUI,
  type CommandHandler,
  type InputFn,
  type OutputFn,
} from "./repl.ts";

export const VERSION = readPackageVersion();

function readPackageVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(
      new URL("../package.json", import.meta.url),
    );
    const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version;
    }
  } catch {
    // Fall through to the placeholder when the package manifest is missing.
  }
  return "0.0.0";
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

export interface MainOptions {
  environ?: Record<string, string | undefined> | undefined;
  configPath?: string | undefined;
  credentialsPath?: string | undefined;
  modelsPath?: string | undefined;
  inputFn?: InputFn | undefined;
  secretInputFn?: InputFn | undefined;
  outputFn?: OutputFn | undefined;
  stdin?: { isTTY?: boolean | undefined } | undefined;
  stdout?: { isTTY?: boolean | undefined } | undefined;
}

export function resetEmptySessionTranscript(
  terminalUi: Pick<TerminalUI, "replaceTranscript" | "showWelcome"> | null,
): void {
  terminalUi?.replaceTranscript([]);
  terminalUi?.showWelcome();
}

/** Refresh presentation without running the governor or triggering compaction. */
export function refreshSessionContextUsage(
  terminalUi: Pick<TerminalUI, "setContextUsage"> | null,
  input: BuildContextInput & {
    readonly tools: readonly ToolSpec[];
    readonly contextWindow: number;
  },
): void {
  if (terminalUi === null) return;
  const context = new ContextBuilder().build(input);
  const estimator = new DefaultTokenEstimator();
  terminalUi.setContextUsage(
    estimator.estimateMessages(context.messages) + estimator.estimateTools(input.tools),
    input.contextWindow,
  );
}

export async function main(
  argv?: readonly string[] | null,
  options: MainOptions = {},
): Promise<number> {
  let parsed: ParseResult;
  try {
    parsed = parseArgs(argv ?? process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeStderr(USAGE);
      writeStderr(`laohuang: error: ${error.message}`);
      return 2;
    }
    throw error;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`laohuang ${VERSION}\n`);
    return 0;
  }
  if (parsed.kind === "help") {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  const args = parsed.args;
  const environ = options.environ ?? process.env;
  const projectRoot = process.cwd();
  // Instruction loading roots at the nearest .git ancestor; the tool
  // registry keeps the plain cwd as its root.
  const instructionRoot = findProjectRoot(process.cwd(), projectRoot);
  const interactive = supportsTerminalUI({
    inputFn: options.inputFn,
    outputFn: options.outputFn,
    stdin: options.stdin,
    stdout: options.stdout,
  });
  const inputFn = options.inputFn ?? defaultInputFn;
  const outputFn = options.outputFn ?? ((message) => console.log(message));
  const secretInputFn = options.secretInputFn ?? defaultSecretInputFn;

  const configPath = options.configPath ?? defaultConfigPath(environ);
  const manager = new ConfigManager(configPath);
  const credentials = new CredentialStore(
    options.credentialsPath ?? join(dirname(configPath), "credentials.json"),
  );
  const modelCatalogStore = new ModelCatalogStore(
    options.modelsPath ?? join(dirname(configPath), "models.json"),
  );
  const modelPlatform = await createPiAiPlatform({
    credentials,
    modelCatalogStore,
    excludedProviderIds: EXCLUDED_PROVIDER_IDS,
    verifiedProviderIds: VERIFIED_PROVIDER_IDS,
  });
  const modelRuntime = new ModelRuntime(modelPlatform.adapter);
  let presenterInput: PromptFn = async (prompt) => inputFn(prompt);
  let presenterSecretInput: PromptFn = async (prompt) => secretInputFn(prompt);
  const providerAuth = new ProviderAuthController({ auth: modelPlatform.auth });
  const selector = new ModelSelector({
    catalog: modelPlatform.catalog,
    providerAuth,
  });
  const startupPresenter = new PlainCommandPresenter({
    output: outputFn,
    input: async (prompt) => inputFn(prompt),
    secretInput: async (prompt) => secretInputFn(prompt),
  });

  if (args.command === "config") {
    if (args.configAction === "list") {
      let profiles;
      try {
        profiles = manager.listProfiles();
      } catch (error) {
        writeStderr(`Configuration error: ${errorMessage(error)}`);
        return 2;
      }
      for (const profile of profiles) {
        const marker = profile.active ? "*" : " ";
        outputFn(
          `${marker} ${profile.name}  ${profile.provider}  ${profile.model}`,
        );
      }
      return 0;
    }

    if (args.configAction === "use") {
      if (!args.configTarget) {
        writeStderr("Configuration error: profile name is required");
        return 2;
      }
      try {
        manager.setActive(args.configTarget);
      } catch (error) {
        writeStderr(`Configuration error: ${errorMessage(error)}`);
        return 2;
      }
      outputFn(`Active profile: ${args.configTarget}`);
      return 0;
    }

    try {
      const selection = await runInitialModelSelection({
        selector,
        presenter: startupPresenter,
        providerAuth,
        providerName: args.provider ?? undefined,
        modelName: args.configModel ?? undefined,
      });
      if (selection === null) {
        return 2;
      }
      manager.configure({
        name: args.configProfile,
        provider: selection.config.provider,
        model: selection.config.model,
        baseUrl: args.configBaseUrl ?? selection.config.baseUrl,
      });
    } catch (error) {
      writeStderr(`Configuration error: ${errorMessage(error)}`);
      return 2;
    }
    outputFn(`Saved profile '${args.configProfile}' to ${configPath}`);
    return 0;
  }

  if (args.command === "doctor") {
    let settings;
    try {
      settings = manager.resolveSettings({
        environ,
        profile: args.profile,
        model: args.model,
        baseUrl: args.baseUrl,
      });
    } catch (error) {
      writeStderr(`Configuration error: ${errorMessage(error)}`);
      return 2;
    }
    const provider = modelPlatform.catalog.getProvider(settings.provider);
    if (provider === undefined) {
      writeStderr(`Configuration error: Unknown provider: ${settings.provider}`);
      return 1;
    }
    const auth = await modelPlatform.auth.status(settings.provider);
    let refreshOk = true;
    try {
      await modelPlatform.catalog.refresh(settings.provider);
    } catch (error) {
      refreshOk = false;
      outputFn(`Catalog refresh: ${errorMessage(error)}`);
    }
    const model = modelPlatform.catalog.getModel(
      settings.provider,
      settings.model,
    );
    outputFn(`Provider: ${settings.provider}`);
    outputFn(`Model: ${settings.model}`);
    outputFn(`Base URL: ${settings.baseUrl ?? "SDK default"}`);
    outputFn(`API key: ${auth.configured ? "configured" : "not configured"}`);
    outputFn(`Verified: ${provider.verified ? "yes" : "no"}`);
    outputFn(`Configuration: ${configPath}`);
    outputFn(`Node: ${process.version}`);
    let bashAvailable = true;
    try {
      outputFn(`Bash: ${resolveBashPath({ shellPath: manager.getShellPath(), env: environ })}`);
    } catch (error) {
      bashAvailable = false;
      outputFn(`Bash: ${errorMessage(error)}`);
    }
    return provider !== undefined && auth.configured && refreshOk && model !== undefined && bashAvailable
      ? 0
      : 1;
  }

  let config: Config;
  let shellPath: string | undefined;
  try {
    shellPath = manager.getShellPath();
    if (existsSync(configPath)) {
      config = manager.resolve({
        environ,
        profile: args.profile,
        model: args.model,
        baseUrl: args.baseUrl,
      });
      if (
        !(await validateConfiguredSelection({
          config,
          catalog: modelPlatform.catalog,
          providerAuth,
          presenter: startupPresenter,
        }))
      ) {
        return 2;
      }
    } else {
      const selection = await runInitialModelSelection({
        selector,
        presenter: startupPresenter,
        providerAuth,
      });
      if (selection === null) {
        return 2;
      }
      config = {
        model: selection.config.model,
        baseUrl: selection.config.baseUrl,
        provider: selection.config.provider,
        profile: null,
      };
      manager.configure({
        name: "default",
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl,
      });
      outputFn(`Configured ${config.provider} / ${config.model} as default.`);
    }
  } catch (error) {
    writeStderr(`Configuration error: ${errorMessage(error)}`);
    return 2;
  }

  // The interactive UI is constructed only once configuration is known; its
  // provider/model are read-only in TS.
  let terminalUi: TerminalUI | null = null;
  let terminalDriver: StdTerminalDriver | null = null;
  let selectedModel = modelPlatform.catalog.getModel(config.provider, config.model);
  const sessionController = new SessionController({
    sessionsRoot: defaultSessionsRoot(environ),
    projectRoot,
    initialCwd: process.cwd(),
    appVersion: VERSION,
    provider: config.provider,
    model: config.model,
    reasoningEffort: "high",
  });
  try {
    if (args.resumeSessionId !== null) {
      await sessionController.resume(args.resumeSessionId);
    } else if (args.continueSession) {
      await sessionController.continueLatest();
    } else {
      await sessionController.createNew();
    }
  } catch (error) {
    writeStderr(`Session error: ${errorMessage(error)}`);
    return 2;
  }
  if (interactive) {
    terminalDriver = new StdTerminalDriver();
    terminalUi = new TerminalUI({
      projectRoot,
      provider: config.provider,
      model: config.model,
      version: VERSION,
      theme: args.theme,
      driver: terminalDriver,
      capabilities: { reasoning: selectedModel?.reasoning ?? false },
      contextWindow: selectedModel?.contextWindow,
    });
    terminalUi.state.provider = config.provider;
    terminalUi.state.model = config.model;
  }

  const toolRegistry = new ToolRegistry([
    ...createFileToolDefinitions({ projectRoot, pathOptions: {
      env: environ,
      shellPath: () => resolveBashPath({ shellPath, env: environ }),
    } }),
    createBashToolDefinition({ projectRoot, shellPath, env: environ }),
  ]);
  const activeConversationHistory = {
    appendUser: (input: Parameters<ConversationHistory["appendUser"]>[0]) => {
      const activeHistory = sessionController.history;
      if (activeHistory === null) throw new Error("no active session");
      return activeHistory.appendUser(input);
    },
    appendAssistant: (input: Parameters<ConversationHistory["appendAssistant"]>[0]) => {
      const activeHistory = sessionController.history;
      if (activeHistory === null) throw new Error("no active session");
      return activeHistory.appendAssistant(input);
    },
    appendToolResults: (input: Parameters<ConversationHistory["appendToolResults"]>[0]) => {
      const activeHistory = sessionController.history;
      if (activeHistory === null) throw new Error("no active session");
      return activeHistory.appendToolResults(input);
    },
    appendReminder: (input: Parameters<ConversationHistory["appendReminder"]>[0]) => {
      const activeHistory = sessionController.history;
      if (activeHistory === null) throw new Error("no active session");
      return activeHistory.appendReminder(input);
    },
  };
  const createContextGovernor = (history: ConversationHistory): ContextGovernor => {
    const modelInfo = selectedModel;
    if (modelInfo === undefined) {
      throw new Error("selected model metadata is unavailable");
    }
    return new ContextGovernor({
      appendCompaction: (payload) => history.appendCompaction(payload),
      summarize: async ({ serialized, maxSummaryTokens }) => {
        const summary = await modelRuntime.complete({
          provider: config.provider,
          model: config.model,
          ...(config.baseUrl === null ? {} : { baseUrl: config.baseUrl }),
          messages: [
            { role: "system", content: COMPACTION_SYSTEM_PROMPT },
            { role: "user", content: serialized },
          ],
          tools: [],
          reasoningEffort: "off",
          temperature: 0,
          maxOutputTokens: Math.min(maxSummaryTokens, modelInfo.maxTokens),
          maxAttempts: 1,
        });
        return {
          summary: summary.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
          inputTokens: summary.usage.inputTokens,
          outputTokens: summary.usage.outputTokens,
        };
      },
    });
  };
  const agent = new CodingAgent({
    modelAdapter: modelPlatform.adapter,
    model: config.model,
    tools: toolRegistry,
    cliName: "laohuang",
    cliVersion: VERSION,
    provider: config.provider,
    baseUrl: config.baseUrl,
    projectRoot: instructionRoot,
    startupCwd: process.cwd(),
    conversationHistory: activeConversationHistory,
    contextGovernor: selectedModel === undefined || sessionController.history === null
      ? null
      : {
          prepare: async ({ tools }): Promise<{
            readonly messages: readonly ModelMessage[];
            readonly contextTokens: number;
            readonly contextWindow: number;
          }> => {
            const history = sessionController.history;
            if (history === null || selectedModel === undefined) {
              return { messages: [], contextTokens: 0, contextWindow: 0 };
            }
            const governor = createContextGovernor(history);
            const prepared = await governor.prepare({
              entries: history.entries(),
              currentProvider: config.provider,
              currentModel: config.model,
              tools,
              budget: {
                contextWindow: selectedModel.contextWindow,
                maxOutputTokens: selectedModel.maxTokens,
              },
              policy: defaultContextPolicy(),
            });
            return {
              messages: prepared.messages,
              contextTokens: prepared.tokens,
              contextWindow: selectedModel.contextWindow,
            };
          },
        },
  });
  const history = sessionController.history;
  if (history !== null) {
    if (history.entries().length === 0) {
      const system = agent.messages.find((message: ModelMessage) => message.role === "system");
      if (system !== undefined) {
        history.appendSystemContext({
          message: system,
          cwd: process.cwd(),
        });
      }
    } else {
      agent.messages = [...new ContextBuilder().build({
        entries: history.entries(),
        currentProvider: config.provider,
        currentModel: config.model,
      }).messages];
      terminalUi?.replaceTranscript(projectTranscript(history.entries()));
    }
  }
  sessionController.setCompactor(async () => {
    const activeHistory = sessionController.history;
    if (activeHistory === null) {
      throw new Error("no active session");
    }
    if (selectedModel === undefined) {
      throw new Error("selected model metadata is unavailable");
    }
    const result = await createContextGovernor(activeHistory).compact({
      entries: activeHistory.entries(),
      currentProvider: config.provider,
      currentModel: config.model,
      tools: toolRegistry.definitions,
      budget: {
        contextWindow: selectedModel.contextWindow,
        maxOutputTokens: selectedModel.maxTokens,
      },
      policy: defaultContextPolicy(),
      trigger: "manual",
    });
    agent.messages = [...new ContextBuilder().build({
      entries: activeHistory.entries(),
      currentProvider: config.provider,
      currentModel: config.model,
    }).messages];
    terminalUi?.replaceTranscript(projectTranscript(activeHistory.entries()));
    return result;
  });
  const semanticClassifier = new SmallModelSemanticClassifier({
    modelRuntime,
    route: {
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
    },
  });
  // agent-runtime satisfies session-runtime's AgentRunnerLike contract, so
  // the app can hand the worker to the session directly.
  let commandDispatcher: CommandHandler | undefined;
  const runtime = new AgentSession(agent, {
    sessionId: sessionController.currentSessionId ?? undefined,
    semanticClassifier,
    commandDispatcher: (command) =>
      commandDispatcher?.(command) ?? { status: "not_found", command },
  });
  const sessionRecorder = new SessionRecorder({
    eventBus: runtime.eventBus,
    journal: () => sessionController.currentJournal,
  });
  terminalUi?.setSessionId(runtime.sessionId);
  const plainSink = terminalUi === null ? new PlainEventSink(outputFn) : null;
  const sessionSink: TerminalUI | PlainEventSink = terminalUi ?? plainSink!;

  let replInputFn: InputFn = inputFn;
  if (plainSink !== null) {
    const underlyingInput = inputFn;
    const underlyingSecretInput = secretInputFn;
    // Setup/command prompts go through the event pipeline in plain mode so
    // they interleave with task output. The Python original also flushed the
    // bus here; TS delivery is microtask-driven and catches up at the next
    // await.
    const plainInput = async (prompt: string): Promise<string> => {
      if (prompt) {
        runtime.publishNotice(prompt);
      }
      return underlyingInput("");
    };
    const plainSecretInput = async (prompt: string): Promise<string> => {
      if (prompt) {
        runtime.publishNotice(prompt);
      }
      return underlyingSecretInput("");
    };
    replInputFn = plainInput;
    presenterInput = plainInput;
    presenterSecretInput = plainSecretInput;
  }
  const commandPresenter: CommandPresenter = terminalUi === null
    ? new PlainCommandPresenter({
        output: outputFn,
        input: presenterInput,
        secretInput: presenterSecretInput,
      })
    : new TerminalCommandPresenter(terminalUi);

  const refreshContextUsage = (): void => {
    refreshSessionContextUsage(terminalUi, {
      entries: sessionController.history?.entries() ?? [],
      currentProvider: config.provider,
      currentModel: config.model,
      tools: toolRegistry.definitions,
      contextWindow: selectedModel?.contextWindow ?? 0,
    });
  };
  refreshContextUsage();

  const refreshSessionView = (): void => {
    const currentSessionId = sessionController.currentSessionId;
    if (currentSessionId !== null) {
      runtime.setSessionId(currentSessionId);
      terminalUi?.setSessionId(currentSessionId);
    }
    const activeHistory = sessionController.history;
    if (activeHistory === null) {
      return;
    }
    const entries = activeHistory.entries();
    if (entries.length === 0) {
      const system = agent.messages.find((message: ModelMessage) => message.role === "system");
      if (system !== undefined) {
        activeHistory.appendSystemContext({
          message: system,
          cwd: process.cwd(),
        });
        agent.messages = [system];
      }
      resetEmptySessionTranscript(terminalUi);
      refreshContextUsage();
      return;
    }
    agent.messages = [...new ContextBuilder().build({
      entries,
      currentProvider: config.provider,
      currentModel: config.model,
    }).messages];
    terminalUi?.replaceTranscript(projectTranscript(entries));
    refreshContextUsage();
  };

  const commands = new SessionCommands({
    agent,
    selector,
    currentConfig: {
      model: config.model,
      baseUrl: config.baseUrl,
      provider: config.provider,
    },
    catalog: modelPlatform.catalog,
    providerAuth,
    presenter: commandPresenter,
    session: runtime,
    sessionController,
    onComposerText: (text) => terminalUi?.setComposerText(text),
    onSessionChanged: refreshSessionView,
    homeDirectory: getHomeDirectory({ env: environ }),
    onModelSelected: (selection) => {
      semanticClassifier.configure({
        provider: selection.config.provider,
        model: selection.config.model,
        baseUrl: selection.config.baseUrl,
      });
      config = {
        ...config,
        provider: selection.config.provider,
        model: selection.config.model,
        baseUrl: selection.config.baseUrl,
      };
      selectedModel = modelPlatform.catalog.getModel(
        selection.config.provider,
        selection.config.model,
      );
      if (terminalUi !== null) {
        const model = selectedModel;
        terminalUi.state.provider = selection.config.provider;
        terminalUi.state.model = selection.config.model;
        terminalUi.setRuntimeCapabilities({ reasoning: model?.reasoning ?? false });
      }
      refreshContextUsage();
    },
  });

  const unsubscribers: Array<() => void> = [];
  const projector = new EventProjector();
  unsubscribers.push(
    runtime.eventBus.subscribe((event) => {
      sessionSink.publishEvent(projector.project(event, "terminal"));
      if (
        event.session_id === runtime.sessionId &&
        (event.kind === "task.completed" || event.kind === "task.cancelled" || event.kind === "task.failed")
      ) {
        refreshContextUsage();
      }
    }),
  );
  if (terminalUi !== null) {
    terminalUi.setCommandRegistry(commands.registry);
    terminalUi.setCancelCallback(() => {
      const action = routeHumanIntent(
        makeCancelIntent("keyboard", "editor"),
        runtime.state,
      );
      void runtime.submitAction(action);
    });
    terminalUi.setKeyActionCallback((action) => {
      if (action === "select_model") {
        void commandDispatcher?.("/model");
        return;
      }
      if (action === "toggle_thinking") {
        terminalUi.toggleReasoningFromKeybinding();
        return;
      }
      commandPresenter.notice({
        text: `Key action is unavailable: ${action}.`,
        tone: "warning",
      });
    });
    terminalUi.setRuntimeRunningCallback(() => runtime.activeTask !== null);
  }

  const handleCommand: CommandHandler = async (command) => {
    const result = await commands.execute(command);
    return result;
  };
  commandDispatcher = handleCommand;

  let cleanShutdown = false;
  try {
    if (terminalUi !== null && terminalDriver !== null) {
      const ui = terminalUi;
      const driver = terminalDriver;
      cleanShutdown = await runSessionRepl(runtime, {
        commandHandler: handleCommand,
        presenter: commandPresenter,
        suggestCommand: (command) => commands.registry.suggest(command),
        ui,
        runUi: (enqueue) => runTerminalUi(ui, driver, enqueue),
      });
    } else {
      cleanShutdown = await runPlainSessionRepl(runtime, {
        commandHandler: handleCommand,
        inputFn: replInputFn,
        presenter: commandPresenter,
        suggestCommand: (command) => commands.registry.suggest(command),
        sink: plainSink!,
      });
    }
  } finally {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    await sessionRecorder.close();
    await sessionController.close();
  }
  return cleanShutdown ? 0 : 1;
}

function defaultSessionsRoot(environ: Record<string, string | undefined>): string {
  return join(getHomeDirectory({ env: environ }), ".laohuang", "sessions");
}

function defaultContextPolicy() {
  return {
    auto: true,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    maxSummaryTokens: 8192,
    safetyRatio: 0.05,
  } as const;
}

export async function runInitialModelSelection(options: {
  readonly selector: ModelSelector;
  readonly presenter: PlainCommandPresenter;
  readonly providerAuth: Pick<ProviderAuthController, "ensureConfigured">;
  readonly providerName?: string;
  readonly modelName?: string;
}): Promise<ModelSelection | null> {
  let providerName = options.providerName;
  if (providerName === undefined) {
    providerName = await options.presenter.select({
      id: "model-provider",
      title: "Select model provider",
      items: options.selector.listProviders().map((provider) => ({
        value: provider.id,
        label: provider.name,
        description: provider.id,
      })),
    }) ?? undefined;
    if (providerName === undefined) {
      return null;
    }
  }

  const authPrompts = presenterAuthPrompts(options.presenter, providerName);

  let modelName = options.modelName;
  if (modelName === undefined) {
    const configured = await options.providerAuth.ensureConfigured(providerName, {
      promptIfMissing: true,
      prompts: authPrompts,
    });
    if (!configured) {
      return null;
    }
    const models = await options.selector.listModels(providerName, "");
    if (models.length === 0) {
      throw new Error(`No models available for provider: ${providerName}`);
    }
    const selected = await options.presenter.select({
      id: "model-name",
      title: `Select model for ${providerName}`,
      items: models.map((model) => ({
        value: `${providerName}/${model.id}`,
        label: model.name,
        description: providerName,
      })),
      searchable: true,
      maxVisible: 20,
    });
    if (selected === null) {
      return null;
    }
    const prefix = `${providerName}/`;
    modelName = selected.startsWith(prefix) ? selected.slice(prefix.length) : selected;
  }

  return options.selector.selectExact({
    providerName,
    modelName,
    promptForMissingKey: true,
    authPrompts,
  });
}

async function validateConfiguredSelection(options: {
  readonly config: Config;
  readonly catalog: ModelCatalog;
  readonly providerAuth: ProviderAuthController;
  readonly presenter: PlainCommandPresenter;
}): Promise<boolean> {
  const provider = options.catalog.getProvider(options.config.provider);
  if (provider === undefined) {
    throw new Error(`Unknown provider: ${options.config.provider}`);
  }
  if (
    !(await options.providerAuth.ensureConfigured(options.config.provider, {
      promptIfMissing: true,
      prompts: presenterAuthPrompts(
        options.presenter,
        options.config.provider,
      ),
    }))
  ) {
    return false;
  }
  await options.catalog.refresh(options.config.provider);
  if (options.catalog.getModel(options.config.provider, options.config.model) === undefined) {
    throw new Error(
      `Unknown model: ${options.config.provider}/${options.config.model}`,
    );
  }
  return true;
}

function presenterAuthPrompts(
  presenter: CommandPresenter,
  provider: string,
): AuthPromptHandler {
  return {
    prompt: (request) => presenter.prompt(
      request.kind === "select"
        ? {
            id: `auth-${provider}`,
            kind: request.kind,
            message: request.message,
            items: (request.options ?? []).map((item) => ({
              value: item.id,
              label: item.label,
              ...(item.description === undefined
                ? {}
                : { description: item.description }),
            })),
          }
        : {
            id: `auth-${provider}`,
            kind: request.kind,
            message: request.message,
          } as PromptPresentation,
    ),
  };
}
