/** Command-line entry and concrete composition for laohuang. */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CodingAgent } from "@laohuang/agent-runtime";
import { ModelRuntime } from "@laohuang/llm";
import { createPiAiAdapter } from "@laohuang/llm-pi-ai";
import {
  ConfigManager,
  CredentialStore,
  defaultConfigPath,
  type Config,
} from "@laohuang/local-config";
import {
  EventProjector,
  makeCancelIntent,
} from "@laohuang/runtime-protocol";
import { findProjectRoot } from "@laohuang/project-instructions";
import { AgentSession, routeHumanIntent } from "@laohuang/session-runtime";
import { PlainEventSink, StdTerminalDriver, TerminalUI } from "@laohuang/tui";
import { ToolRegistry } from "@laohuang/tools";
import { createFileToolDefinitions } from "@laohuang/tool-fs";
import { createBashToolDefinition } from "@laohuang/tool-bash";

import {
  SessionCommands,
  type CommandResult,
  type QueueStatus,
} from "./commands.ts";
import {
  AdapterProviderCatalog,
  getProvider,
  providerNames,
} from "./model-catalog.ts";
import { ModelSelector, type InputFn as PromptFn } from "./model-selection.ts";
import { SmallModelSemanticClassifier } from "./semantic-classifier.ts";
import {
  CliUsageError,
  HELP,
  USAGE,
  parseArgs,
  type ParseResult,
} from "./args.ts";
import {
  defaultInputFn,
  defaultSecretInputFn,
  errorMessage,
  runPlainSessionRepl,
  runSessionRepl,
  runTerminalUi,
  supportsTerminalUI,
  terminalUiPrompts,
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
  inputFn?: InputFn | undefined;
  secretInputFn?: InputFn | undefined;
  outputFn?: OutputFn | undefined;
  stdin?: { isTTY?: boolean | undefined } | undefined;
  stdout?: { isTTY?: boolean | undefined } | undefined;
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
  const modelAdapter = createPiAiAdapter({
    enabledProviders: providerNames(),
    resolveApiKey: (provider) => credentials.get(provider),
  });
  const modelRuntime = new ModelRuntime(modelAdapter);
  const modelCatalog = new AdapterProviderCatalog(modelAdapter);
  // The selector's input/output targets are rewired once the session exists,
  // mirroring the Python original which mutated selector.input_fn/output_fn.
  // Like the Python original, the selector's own secret prompts (first-run
  // setup, `config` subcommand) always use the default secret reader — only
  // the session commands switch to the terminal UI's secret prompt.
  let selectorInput: PromptFn = async (prompt) => inputFn(prompt);
  const selectorSecretInput: PromptFn = async (prompt) => secretInputFn(prompt);
  let selectorOutput: OutputFn = outputFn;
  const selector = new ModelSelector({
    credentials,
    catalog: modelCatalog,
    input: (prompt) => selectorInput(prompt),
    secretInput: (prompt) => selectorSecretInput(prompt),
    output: (message) => {
      selectorOutput(message);
    },
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
      const selection = await selector.select({
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
    try {
      getProvider(settings.provider);
    } catch (error) {
      writeStderr(`Configuration error: ${errorMessage(error)}`);
      return 2;
    }
    const keyConfigured = credentials.get(settings.provider) !== null;
    outputFn(`Provider: ${settings.provider}`);
    outputFn(`Model: ${settings.model}`);
    outputFn(`Base URL: ${settings.baseUrl ?? "SDK default"}`);
    outputFn(`API key: ${keyConfigured ? "configured" : "not configured"}`);
    outputFn(`Configuration: ${configPath}`);
    outputFn(`Node: ${process.version}`);
    outputFn(`Bash: ${existsSync("/bin/bash") ? "available" : "missing"}`);
    return keyConfigured ? 0 : 1;
  }

  let config: Config;
  try {
    if (existsSync(configPath)) {
      config = manager.resolve({
        credentials,
        environ,
        profile: args.profile,
        model: args.model,
        baseUrl: args.baseUrl,
      });
    } else {
      const selection = await selector.select();
      if (selection === null) {
        return 2;
      }
      config = {
        model: selection.config.model,
        baseUrl: selection.config.baseUrl,
        provider: selection.config.provider,
        profile: null,
        apiKey: selection.config.apiKey,
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
    const message = errorMessage(error);
    if (existsSync(configPath) && message.startsWith("No API key configured")) {
      // A stored profile without its API key re-runs interactive selection
      // for the resolved provider/model (first-run setup flow).
      let selection;
      try {
        const settings = manager.resolveSettings({
          environ,
          profile: args.profile,
          model: args.model,
          baseUrl: args.baseUrl,
        });
        selection = await selector.select({
          providerName: settings.provider,
          modelName: settings.model,
        });
      } catch (selectionError) {
        writeStderr(`Configuration error: ${errorMessage(selectionError)}`);
        return 2;
      }
      if (selection === null) {
        return 2;
      }
      config = {
        model: selection.config.model,
        baseUrl: selection.config.baseUrl,
        provider: selection.config.provider,
        profile: null,
        apiKey: selection.config.apiKey,
      };
    } else {
      writeStderr(`Configuration error: ${message}`);
      return 2;
    }
  }

  try {
    getProvider(config.provider);
  } catch (error) {
    writeStderr(`Configuration error: ${errorMessage(error)}`);
    return 2;
  }

  // The interactive UI is constructed only once configuration is known; its
  // provider/model are read-only in TS.
  let terminalUi: TerminalUI | null = null;
  let terminalDriver: StdTerminalDriver | null = null;
  if (interactive) {
    terminalDriver = new StdTerminalDriver();
    terminalUi = new TerminalUI({
      projectRoot,
      provider: config.provider,
      model: config.model,
      theme: args.theme,
      driver: terminalDriver,
    });
    terminalUi.state.provider = config.provider;
    terminalUi.state.model = config.model;
  }

  const agent = new CodingAgent({
    modelAdapter,
    model: config.model,
    tools: new ToolRegistry([
      ...createFileToolDefinitions({ projectRoot }),
      createBashToolDefinition({ projectRoot }),
    ]),
    provider: config.provider,
    baseUrl: config.baseUrl,
    projectRoot: instructionRoot,
    startupCwd: process.cwd(),
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
    semanticClassifier,
    commandDispatcher: (command) =>
      commandDispatcher?.(command) ?? { status: "not_found", command },
  });
  const plainSink = terminalUi === null ? new PlainEventSink(outputFn) : null;
  const sessionSink: TerminalUI | PlainEventSink = terminalUi ?? plainSink!;

  let replInputFn: InputFn = inputFn;
  let commandsSecretInput: PromptFn = selectorSecretInput;
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
    selectorInput = plainInput;
    commandsSecretInput = plainSecretInput;
  } else if (terminalUi !== null) {
    // /login and interactive /model run while the terminal loop owns stdin in
    // raw mode: their questions must be asked through the UI loop, not read
    // from fd 0 directly.
    const prompts = terminalUiPrompts(terminalUi);
    selectorInput = prompts.input;
    commandsSecretInput = prompts.secretInput;
  }
  selectorOutput = (message) => {
    runtime.publishNotice(message);
  };
  const sessionOutput = (message: string): void => {
    runtime.publishNotice(message);
  };

  const commands = new SessionCommands({
    agent,
    selector,
    credentials,
    currentConfig: {
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl,
      provider: config.provider,
    },
    input: (prompt) => selectorInput(prompt),
    secretInput: (prompt) => commandsSecretInput(prompt),
    output: sessionOutput,
    session: runtime,
    onModelSelected: (selection) => {
      semanticClassifier.configure({
        provider: selection.config.provider,
        model: selection.config.model,
        baseUrl: selection.config.baseUrl,
      });
    },
  });

  const unsubscribers: Array<() => void> = [];
  const projector = new EventProjector();
  unsubscribers.push(
    runtime.eventBus.subscribe((event) => {
      sessionSink.publishEvent(projector.project(event, "terminal"));
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
      if (action === "clear_screen") {
        void commandDispatcher?.("/clear");
        return;
      }
      runtime.publishNotice(`Key action is unavailable: ${action}.`);
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
        ui,
        runUi: (enqueue) => runTerminalUi(ui, driver, enqueue),
      });
    } else {
      cleanShutdown = await runPlainSessionRepl(runtime, {
        commandHandler: handleCommand,
        inputFn: replInputFn,
        sink: plainSink!,
      });
    }
  } finally {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  }
  return cleanShutdown ? 0 : 1;
}
