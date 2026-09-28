/**
 * laohuang 的命令行入口与应用装配。
 * 执行顺序：参数分流 → 配置与认证 → 会话和工具装配 → 输入循环 → 资源清理。
 * config、doctor、update 等子命令处理完成后直接退出，不进入会话循环。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ModelCatalog, ModelMessage, ModelPlatform } from "@laohuang/llm";
import { ContextUsage, type BuildContextInput } from "@laohuang/session-context";
import { projectTranscript } from "@laohuang/session-store";
import { createPiAiPlatform } from "@laohuang/llm-pi-ai";
import { ConfigManager, CustomModelsStore, CredentialStore, ModelCatalogStore, defaultConfigPath, type Config } from "@laohuang/local-config";
import { EventProjector, makeCancelIntent } from "@laohuang/runtime-protocol";
import { findProjectRoot } from "@laohuang/project-instructions";
import { type AgentSession, SessionState, routeHumanIntent } from "@laohuang/session-runtime";
import { PlainEventSink, PromptCancelledError, PromptEofError, StdTerminalDriver, TerminalUI } from "@laohuang/tui";
import { ToolRegistry, type ToolSpec } from "@laohuang/tools";
import { createFileToolDefinitions, createReadImageTool } from "@laohuang/tool-fs";
import { getHomeDirectory } from "@laohuang/local-paths";
import { createBashToolDefinition, resolveBashPath } from "@laohuang/tool-bash";

import { SessionCommands, type CommandResult, type QueueStatus } from "./commands.ts";
import type { CommandPresenter, PromptPresentation } from "./command-presentation.ts";
import { ModelSelector, type InputFn as PromptFn, type ModelSelection } from "./model-selection.ts";
import { PlainCommandPresenter } from "./plain-command-presenter.ts";
import { ProviderAuthController, type AuthPromptHandler } from "./provider-auth.ts";
import { EXCLUDED_PROVIDER_IDS, VERIFIED_PROVIDER_IDS } from "./provider-policy.ts";
import { TerminalCommandPresenter } from "./terminal-command-presenter.ts";
import { CliUsageError, HELP, UPDATE_HELP, USAGE, parseArgs, type ParseResult } from "./args.ts";
import { SessionController } from "./session-controller.ts";
import { createSessionRuntime, type SessionRuntime } from "./create-session-runtime.ts";
import { createMcpRuntime, type McpRuntime } from "./create-mcp-runtime.ts";
import { createMcpCommand } from "./mcp-commands.ts";
import { createSkillRuntime, type SkillRuntime } from "./create-skill-runtime.ts";
import { createAttachmentRuntime } from "./create-attachment-runtime.ts";
import { defaultInputFn, defaultSecretInputFn, errorMessage, runPlainSessionRepl, runSessionRepl, runTerminalUi, supportsTerminalUI, type CommandHandler, type InputFn, type OutputFn } from "./repl.ts";
import { resolveNpmInstallation } from "./update-installation.ts";
import { runUpdate, updateDiagnostic } from "./update.ts";
import { copyText, createClipboardRunner } from "./clipboard.ts";
import { createClipboardPaste } from "./clipboard-paste.ts";

export const VERSION = readPackageVersion();

/** 从 CLI 包的清单读取版本，避免在入口中重复维护版本号。 */
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
    // 清单缺失、读取失败或 JSON 无效时，使用下方的占位版本。
  }
  return "0.0.0";
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** 可注入的环境、存储路径和输入输出，便于测试隔离真实终端与用户配置。 */
export interface MainOptions {
  environ?: Record<string, string | undefined> | undefined;
  configPath?: string | undefined;
  credentialsPath?: string | undefined;
  modelsPath?: string | undefined;
  customModelsPath?: string | undefined;
  inputFn?: InputFn | undefined;
  secretInputFn?: InputFn | undefined;
  outputFn?: OutputFn | undefined;
  stdin?: { isTTY?: boolean | undefined } | undefined;
  stdout?: { isTTY?: boolean | undefined } | undefined;
  updateFn?: ((signal?: AbortSignal) => Promise<number>) | undefined;
}

/** 切换到空会话时清除旧消息，并重新显示欢迎内容。 */
export function resetEmptySessionTranscript(
  terminalUi: Pick<TerminalUI, "replaceTranscript" | "showWelcome"> | null,
): void {
  terminalUi?.replaceTranscript([]);
  terminalUi?.showWelcome();
}

/** 仅刷新上下文用量显示，不执行上下文治理或触发压缩。 */
export function refreshSessionContextUsage(
  terminalUi: Pick<TerminalUI, "setContextUsage"> | null,
  input: BuildContextInput & {
    readonly tools: readonly ToolSpec[];
    readonly projectTools?: (messages: readonly ModelMessage[]) => readonly ToolSpec[];
    readonly contextWindow: number;
  },
): void {
  if (terminalUi === null) return;
  terminalUi.setContextUsage(
    new ContextUsage(input.entries).tokens,
    input.contextWindow,
  );
}

/** 执行 CLI 并返回退出码；由调用方决定如何退出进程。 */
export async function main(
  argv?: readonly string[] | null,
  options: MainOptions = {},
): Promise<number> {
  // 先处理参数错误、版本和帮助，避免这些路径依赖配置或模型平台。
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
  const environ = options.environ ?? process.env;
  const outputFn = options.outputFn ?? ((message: string) => console.log(message));
  if (parsed.kind === "update-help") {
    outputFn(UPDATE_HELP);
    return 0;
  }
  if (parsed.kind === "update") {
    // 将进程信号转为更新操作的取消信号，并保留对应的退出码。
    const controller = new AbortController();
    let signalExitCode: 130 | 143 | null = null;
    const handleSigint = (): void => {
      signalExitCode ??= 130;
      controller.abort();
    };
    const handleSigterm = (): void => {
      signalExitCode ??= 143;
      controller.abort();
    };
    process.once("SIGINT", handleSigint);
    process.once("SIGTERM", handleSigterm);
    try {
      let result: number;
      if (options.updateFn !== undefined) {
        result = await options.updateFn(controller.signal);
      } else {
        const entryPath = process.argv[1];
        if (entryPath === undefined) {
          throw new Error("CLI entry path is unavailable");
        }
        const installation = await resolveNpmInstallation(entryPath, environ, {
          signal: controller.signal,
        });
        result = await runUpdate({
          installation,
          output: outputFn,
          signal: controller.signal,
        });
      }
      return signalExitCode ?? result;
    } catch (error) {
      outputFn(`${controller.signal.aborted ? "Update cancelled" : "Update failed"}: ${updateDiagnostic(error)}`);
      return signalExitCode ?? (controller.signal.aborted ? 130 : 1);
    } finally {
      process.removeListener("SIGINT", handleSigint);
      process.removeListener("SIGTERM", handleSigterm);
    }
  }
  const args = parsed.args;
  const projectRoot = process.cwd();
  // 项目指令从最近的 .git 祖先目录加载；文件和命令工具仍以当前工作目录为根。
  const instructionRoot = findProjectRoot(process.cwd(), projectRoot);
  const interactive = supportsTerminalUI({
    inputFn: options.inputFn,
    outputFn: options.outputFn,
    stdin: options.stdin,
    stdout: options.stdout,
  });
  const inputFn = options.inputFn ?? defaultInputFn;
  const secretInputFn = options.secretInputFn ?? defaultSecretInputFn;

  // 配置、凭据、模型目录缓存和自定义模型分别存储，默认放在同一配置目录。
  const configPath = options.configPath ?? defaultConfigPath(environ);
  const manager = new ConfigManager(configPath);
  const credentials = new CredentialStore(
    options.credentialsPath ?? join(dirname(configPath), "credentials.json"),
  );
  const modelCatalogStore = new ModelCatalogStore(
    options.modelsPath ?? join(dirname(configPath), "models.json"),
  );
  const customModels = new CustomModelsStore(
    options.customModelsPath ?? join(dirname(configPath), "custom-models.json"),
  );
  let modelPlatform: ModelPlatform;
  let attachmentRuntime: ReturnType<typeof createAttachmentRuntime> | undefined;
  try {
    modelPlatform = await createPiAiPlatform({
      // 附件运行时稍后才创建，通过回调取得届时可用的存储实例。
      attachments: { store: () => attachmentRuntime?.store },
      credentials,
      modelCatalogStore,
      excludedProviderIds: EXCLUDED_PROVIDER_IDS,
      verifiedProviderIds: VERIFIED_PROVIDER_IDS,
      readCustomModels: () => customModels.read(),
      environ,
    });
  } catch (error) {
    writeStderr(`Configuration error: ${errorMessage(error)}`);
    return 2;
  }
  let presenterInput: PromptFn = async (prompt) => inputFn(prompt);
  let presenterSecretInput: PromptFn = async (prompt) => secretInputFn(prompt);
  const providerAuth = new ProviderAuthController({ auth: modelPlatform.auth });
  const selector = new ModelSelector({
    catalog: modelPlatform.catalog,
    providerAuth,
  });
  // 启动配置阶段尚未创建 TUI，统一使用普通输入输出完成选择和认证。
  const startupPresenter = new PlainCommandPresenter({
    output: outputFn,
    input: async (prompt) => inputFn(prompt),
    secretInput: async (prompt) => secretInputFn(prompt),
  });

  if (args.command === "config") {
    // 配置子命令：列出配置、切换当前配置，或选择模型并保存指定配置。
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
    // 诊断配置、认证状态、模型目录和 Bash 可用性，汇总为诊断退出码。
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

  // 会话启动前解析配置，并确认服务商、认证和模型仍然可用。
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
      const validation = await validateConfiguredSelection({
        config,
        catalog: modelPlatform.catalog,
        providerAuth,
        presenter: startupPresenter,
      });
      if (validation === false) {
        return 2;
      }
      if (typeof validation === "string") {
        // 仅在交互终端且未显式覆盖模型时，引导用户修复失效的已存配置。
        const canRecover = (options.stdin ?? process.stdin).isTTY === true
          && (options.stdout ?? process.stdout).isTTY === true
          && !args.model && !environ["LAOHUANG_MODEL"];
        if (!canRecover) throw new Error(validation);
        outputFn(`${validation}. Please reconfigure profile '${config.profile}'.`);
        let selection: ModelSelection | null;
        try {
          selection = await runInitialModelSelection({ selector, presenter: startupPresenter, providerAuth });
        } catch (error) {
          if (!(error instanceof PromptCancelledError) && !(error instanceof PromptEofError)) throw error;
          selection = null;
        }
        if (selection === null) {
          outputFn("Configuration cancelled.");
          return 0;
        }
        // 同一服务商保留原有地址；切换服务商时使用新选择的地址。
        // 持久化配置与本次运行的参数、环境变量覆盖分别处理。
        const saved = manager.resolve({ environ: {}, profile: config.profile });
        const baseUrl = selection.config.provider === saved.provider ? saved.baseUrl : selection.config.baseUrl;
        manager.configure({
          name: config.profile!, provider: selection.config.provider,
          model: selection.config.model, baseUrl,
        });
        config = { ...config, ...selection.config, baseUrl: args.baseUrl ?? environ["LAOHUANG_BASE_URL"] ?? baseUrl };
        outputFn(`Saved profile '${config.profile}' to ${configPath}`);
      }
    } else {
      // 尚无配置文件时完成首次选择，并写入 default 配置。
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

  // 配置确定后再准备界面和会话资源，保证初始模型信息一致。
  let terminalUi: TerminalUI | null = null;
  const clipboardPaste = createClipboardPaste({ platform: process.platform, env: environ });
  let terminalDriver: StdTerminalDriver | null = null;
  let selectedModel = modelPlatform.catalog.getModel(config.provider, config.model);
  attachmentRuntime = createAttachmentRuntime({
    root: join(getHomeDirectory({ env: environ }), ".laohuang", "attachments"),
    sessionsRoot: defaultSessionsRoot(environ),
    onError: error => writeStderr(`Attachment cleanup failed: ${errorMessage(error)}`),
  });
  const sessionController = new SessionController({
    attachments: attachmentRuntime.store,
    sessionsRoot: defaultSessionsRoot(environ),
    projectRoot,
    initialCwd: process.cwd(),
    appVersion: VERSION,
    provider: config.provider,
    model: config.model,
    reasoningEffort: "high",
  });
  let mcpRuntime: McpRuntime | undefined;
  let skillRuntime: SkillRuntime | undefined;
  let skillDraft: string | undefined;
  // 保存已成功创建的资源，确保初始化中途失败时也能进入统一清理流程。
  let runtimeForCleanup: AgentSession | undefined;
  let composedForCleanup: SessionRuntime | undefined;
  const unsubscribers: Array<() => void> = [];
  try {
    try {
      // 优先恢复指定会话，其次继续最近会话，否则创建新会话。
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
        clipboardReader: signal => clipboardPaste.read(signal),
        capabilities: { reasoning: selectedModel?.reasoning ?? false },
        contextWindow: selectedModel?.contextWindow,
      });
      terminalUi.state.provider = config.provider;
      terminalUi.state.model = config.model;
    }

    // 先加载技能，再将技能工具与图片、文件、Bash 工具装入同一注册表。
    skillRuntime = await createSkillRuntime({ configPath, projectRoot: instructionRoot,
      home: getHomeDirectory({ env: environ }), report: message => {
        if (runtimeForCleanup) runtimeForCleanup.publishNotice(message);
        else outputFn(message);
      } });
    const toolRegistry = new ToolRegistry([
      createReadImageTool({ store: attachmentRuntime.store, projectRoot,
        pathOptions: { env: environ, shellPath: () => resolveBashPath({ shellPath, env: environ }) },
        resolveReference: id => {
          // 从当前会话历史解析图片引用，使恢复会话中的附件仍可被读取。
          for (const entry of sessionController.history?.entries() ?? []) {
            if (!("message" in entry.payload) || !("attachments" in entry.payload.message)) continue;
            for (const block of entry.payload.message.attachments ?? []) if (block.type === "image" && block.ref.id === id) return block.ref;
          }
          return undefined;
        },
      }),
      skillRuntime.session.tool,
      ...createFileToolDefinitions({ projectRoot, pathOptions: {
        env: environ,
        shellPath: () => resolveBashPath({ shellPath, env: environ }),
      } }),
      createBashToolDefinition({ projectRoot, shellPath, env: environ }),
    ]);
    // 命令对象依赖会话运行时，因此先注入转发回调，待命令装配完成后再绑定。
    let commandDispatcher: CommandHandler | undefined;
    let runtimeInitialized = false;
    const composedRuntime = createSessionRuntime({
      attachments: attachmentRuntime.store,
      modelAdapter: modelPlatform.adapter,
      catalog: modelPlatform.catalog,
      route: { provider: config.provider, model: config.model, baseUrl: config.baseUrl },
      tools: toolRegistry,
      skills: skillRuntime.session,
      skillInputFailed: (input) => {
        // 技能输入失败时保留原文：TUI 回填编辑器，纯文本模式允许空行重试。
        terminalUi?.setComposerText(input);
        if (!terminalUi) {
          skillDraft = input;
          outputFn(`Skill input retained:\n${input}\nSubmit an empty line to retry, or enter a replacement.`);
        }
      },
      prepareTools: (signal) => mcpRuntime?.prepareTools(signal) ?? Promise.resolve(),
      sessionController,
      projectRoot: instructionRoot,
      startupCwd: process.cwd(),
      version: VERSION,
      presentation: terminalUi === null ? undefined : {
        sessionChanged: (sessionId) => terminalUi?.setSessionId(sessionId),
        historyChanged: (entries) => {
          const transcript = projectTranscript(entries);
          if (transcript.length > 0) {
            terminalUi?.replaceTranscript(transcript);
          } else if (runtimeInitialized) {
            // 初始化期间不重复显示欢迎内容；后续切换到空历史时才重置界面。
            resetEmptySessionTranscript(terminalUi);
          }
        },
        contextUsageChanged: ({ contextTokens, contextWindow }) =>
          terminalUi?.setContextUsage(contextTokens, contextWindow),
      },
      commandDispatcher: (command) =>
        commandDispatcher?.(command) ?? { status: "not_found", command },
    });
    runtimeInitialized = true;
    composedForCleanup = composedRuntime;
    const { agent, session: runtime } = composedRuntime;
    runtimeForCleanup = runtime;
    const plainSink = terminalUi === null ? new PlainEventSink(outputFn) : null;
    const sessionSink: TerminalUI | PlainEventSink = terminalUi ?? plainSink!;

    let replInputFn: InputFn = inputFn;
    if (plainSink !== null) {
      const underlyingInput = inputFn;
      const underlyingSecretInput = secretInputFn;
      // 纯文本模式的提问通过事件管线输出，与任务消息共享输出通道。
      // 底层输入函数接收空提示，避免重复打印；事件投递由微任务推进。
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

    const refreshContextUsage = (): void => composedRuntime.refreshContextUsage();
    refreshContextUsage();

    // MCP 与内置工具共用注册表，工具变化时同步刷新上下文用量。
    mcpRuntime = await createMcpRuntime({ configPath, projectRoot, version: VERSION, registry: toolRegistry,
      presenter: commandPresenter, env: environ, toolsChanged: refreshContextUsage });

    const refreshSessionView = (): void => composedRuntime.refreshSession();

    const clipboardRunner = createClipboardRunner(environ);
    // 装配会话命令，将模型选择、会话切换和剪贴板操作接入当前运行时与界面。
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
      copyText: (text) => copyText(text, {
        platform: process.platform,
        environ,
        isTTY: (options.stdout ?? process.stdout).isTTY === true,
        writeTerminal: (sequence) => {
          if (terminalDriver !== null) {
            terminalDriver.write(sequence);
          } else {
            process.stdout.write(sequence);
          }
        },
        run: clipboardRunner,
      }),
      session: runtime,
      sessionController,
      onComposerText: (text) => terminalUi?.setComposerText(text),
      onSessionChanged: refreshSessionView,
      homeDirectory: getHomeDirectory({ env: environ }),
      onModelSelected: (selection) => {
        // 模型切换同时更新运行时路由、本地配置快照、界面能力和上下文用量。
        composedRuntime.switchModel({
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

    commands.registry.register(createMcpCommand(mcpRuntime, commandPresenter));
    await skillRuntime.attachCommands(commands.registry);
    // 将运行时事件投影为终端事件，交给 TUI 或纯文本输出器显示。
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
        // 取消键优先关闭 MCP 授权交互，否则按当前会话状态路由取消意图。
        if (mcpRuntime?.cancelAuthorization()) return;
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
          terminalUi?.toggleReasoningFromKeybinding();
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

    // 按终端能力选择输入循环；循环启动后再启动 MCP，以便呈现授权提示。
    let cleanShutdown = false;
    const startMcp = () => { void mcpRuntime?.start().catch(() => commandPresenter.notice({ text: "MCP startup failed", tone: "error" })); };
    if (terminalUi !== null && terminalDriver !== null) {
      const ui = terminalUi;
      const driver = terminalDriver;
      cleanShutdown = await runSessionRepl(runtime, {
        commandHandler: handleCommand,
        presenter: commandPresenter,
        suggestCommand: (command) => commands.registry.suggest(command),
        ui,
        runUi: async (enqueue) => {
          const running = runTerminalUi(ui, driver, enqueue);
          startMcp();
          try { await running; } finally { mcpRuntime?.cancelAuthorization(); }
        },
      });
    } else {
      const running = runPlainSessionRepl(runtime, {
        commandHandler: handleCommand,
        inputFn: replInputFn,
        presenter: commandPresenter,
        suggestCommand: (command) => commands.registry.suggest(command),
        sink: plainSink!,
        recoverInput: () => { const input = skillDraft; skillDraft = undefined; return input; },
      });
      startMcp();
      cleanShutdown = await running;
    }
    // 渲染失败需要作为错误上报，不能当作用户正常退出。
    const renderError = terminalUi?.renderError ?? null;
    if (renderError !== null) {
      throw new Error(`Terminal rendering failed: ${errorMessage(renderError)}`, { cause: renderError });
    }
    return cleanShutdown ? 0 : 1;
  } finally {
    // 先取消授权并停止任务，再退订事件、关闭 MCP、技能及会话等资源。
    // 嵌套 finally 确保某一步关闭失败后，后续资源仍会尝试释放。
    mcpRuntime?.cancelAuthorization();
    try { if (runtimeForCleanup && runtimeForCleanup.state !== SessionState.Stopped) await runtimeForCleanup.close({ wait: true, timeoutMs: 10_000 }); }
    finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
      try { await mcpRuntime?.close(); }
      finally {
        try { await skillRuntime?.close(); }
        finally {
          try {
            if (composedForCleanup) await composedForCleanup.close();
            else await sessionController.close();
          } finally {
            try { await clipboardPaste.close(); }
            finally { attachmentRuntime.close(); }
          }
        }
      }
    }
  }
}

/** 会话数据默认保存在用户目录下的 .laohuang/sessions。 */
function defaultSessionsRoot(environ: Record<string, string | undefined>): string {
  return join(getHomeDirectory({ env: environ }), ".laohuang", "sessions");
}

/** 补齐服务商和模型选择，完成所需认证；用户取消选择时返回 null。 */
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

/** 返回 true 表示可用，false 表示认证未完成，字符串表示服务商或模型失效。 */
async function validateConfiguredSelection(options: {
  readonly config: Config;
  readonly catalog: ModelCatalog;
  readonly providerAuth: ProviderAuthController;
  readonly presenter: PlainCommandPresenter;
}): Promise<boolean | string> {
  const provider = options.catalog.getProvider(options.config.provider);
  if (provider === undefined) {
    return `Unknown provider: ${options.config.provider}`;
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
    return `Unknown model: ${options.config.provider}/${options.config.model}`;
  }
  return true;
}

/** 将认证层的提问格式转换为命令展示层的统一提示格式。 */
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
