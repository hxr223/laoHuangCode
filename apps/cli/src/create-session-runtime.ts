import { CodingAgent } from "@laohuang/agent-runtime";
import type { AttachmentStore } from "@laohuang/attachment";
import type { SkillSession } from "@laohuang/tool-skill";
import {
  ModelRuntime,
  type ModelAdapter,
  type ModelCatalog,
  type ModelInfo,
  type ModelMessage,
} from "@laohuang/llm";
import type { CommandResult } from "@laohuang/runtime-protocol";
import {
  COMPACTION_SYSTEM_PROMPT,
  ContextBuilder,
  ContextGovernor,
  type CompactionResult,
  type ConversationHistory,
} from "@laohuang/session-context";
import { AgentSession, SessionRecorder } from "@laohuang/session-runtime";
import type { SessionEntry } from "@laohuang/session-store";
import { ToolSelection, type ToolRegistryLike } from "@laohuang/tools";

import { SessionController } from "./session-controller.ts";
import { SmallModelSemanticClassifier } from "./semantic-classifier.ts";

export interface SessionRoute {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string | null;
}

export interface SessionRuntimePresentation {
  historyChanged?(entries: readonly SessionEntry[]): void;
  sessionChanged?(sessionId: string): void;
  contextUsageChanged?(usage: {
    readonly contextTokens: number | null;
    readonly contextWindow: number;
  }): void;
}

export interface CreateSessionRuntimeOptions {
  readonly attachments?: AttachmentStore;
  readonly skills?: SkillSession;
  readonly skillInputFailed?: (input: string, error: unknown) => void;
  readonly modelAdapter: ModelAdapter;
  readonly catalog: ModelCatalog;
  readonly route: SessionRoute;
  readonly tools: ToolRegistryLike;
  readonly prepareTools?: (signal?: AbortSignal) => Promise<void>;
  readonly sessionController: SessionController;
  readonly projectRoot: string;
  readonly startupCwd: string;
  readonly version: string;
  readonly presentation?: SessionRuntimePresentation;
  readonly commandDispatcher?: (
    command: string,
  ) => CommandResult | Promise<CommandResult>;
}

export interface SessionRuntime {
  readonly agent: CodingAgent;
  readonly session: AgentSession;
  readonly classifier: SmallModelSemanticClassifier;
  readonly route: SessionRoute;
  refreshSession(): void;
  switchModel(route: SessionRoute): void;
  compact(): Promise<CompactionResult>;
  refreshContextUsage(): void;
  /** Close recorder and persisted session after the caller stops AgentSession. */
  close(): Promise<void>;
}

export function createSessionRuntime(
  options: CreateSessionRuntimeOptions,
): SessionRuntime {
  let route = { ...options.route };
  let selectedModel = modelInfo(options.catalog, route);
  let attachmentTurnStart: number | undefined;
  const adapter: ModelAdapter = {
    name: options.modelAdapter.name,
    runAttempt: request => {
      const history = options.sessionController.history;
      const entries = history?.entries() ?? [];
      const boundary = attachmentTurnStart ?? [...entries].reverse().find(entry => entry.entryType === "user_message")?.seq ?? 0;
      const protectedKeys = new Set<string>();
      for (const entry of entries) {
        if (entry.seq < boundary || !("message" in entry.payload)) continue;
        const message = entry.payload.message;
        if (!("attachments" in message)) continue;
        for (const [index] of (message.attachments ?? []).entries()) protectedKeys.add(`${message.attachmentKey}:${index}`);
      }
      return options.modelAdapter.runAttempt({ ...request, imageContext: {
        offloaded: new Set(entries.flatMap(entry => entry.entryType === "image_offload" ? entry.payload.keys : [])),
        protectedKeys,
        persistOffload: keys => {
          if (!history) throw new Error("Cannot persist image offload without an active session");
          history.offloadImages(keys);
        },
      } });
    },
  };
  const modelRuntime = new ModelRuntime(adapter);
  let releaseAttachments: (() => void) | undefined;
  const activeConversationHistory = {
    appendSkillContext: (input: Parameters<ConversationHistory["appendSkillContext"]>[0]) =>
      activeHistory(options.sessionController).appendSkillContext(input),
    appendToolDefinitions: (input: Parameters<ConversationHistory["appendToolDefinitions"]>[0]) =>
      activeHistory(options.sessionController).appendToolDefinitions(input),
    appendToolCatalog: (input: Parameters<ConversationHistory["appendToolCatalog"]>[0]) =>
      activeHistory(options.sessionController).appendToolCatalog(input),
    appendUser: (input: Parameters<ConversationHistory["appendUser"]>[0]) =>
      activeHistory(options.sessionController).appendUser(input),
    appendAssistant: (
      input: Parameters<ConversationHistory["appendAssistant"]>[0],
    ) => activeHistory(options.sessionController).appendAssistant(input),
    appendToolResults: (
      input: Parameters<ConversationHistory["appendToolResults"]>[0],
    ) => activeHistory(options.sessionController).appendToolResults(input),
    appendReminder: (
      input: Parameters<ConversationHistory["appendReminder"]>[0],
    ) => activeHistory(options.sessionController).appendReminder(input),
  };

  const createGovernor = (history: ConversationHistory): ContextGovernor =>
    new ContextGovernor({
      appendCompaction: (payload) => history.appendCompaction(payload),
      summarize: async ({ serialized, maxSummaryTokens }) => {
        const summary = await modelRuntime.complete({
          provider: route.provider,
          model: route.model,
          ...(route.baseUrl === null ? {} : { baseUrl: route.baseUrl }),
          messages: [
            { role: "system", content: COMPACTION_SYSTEM_PROMPT },
            { role: "user", content: serialized },
          ],
          tools: [],
          reasoningEffort: "off",
          temperature: 0,
          maxOutputTokens: Math.min(maxSummaryTokens, selectedModel.maxTokens),
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

  const agent = new CodingAgent({
    resources: {
      prepareInput: async (input, signal, inputs) => {
        attachmentTurnStart ??= (options.sessionController.history?.entries().at(-1)?.seq ?? 0) + 1;
        releaseAttachments ??= options.attachments?.protect();
        try { return await options.skills?.prepareInput(input, signal, inputs) ?? { role: "user", content: input }; }
        catch (error) { if (!signal?.aborted) options.skillInputFailed?.(inputs?.join("\n\n") ?? input, error); throw error; }
      },
      prepareContext: (messages, signal) => options.skills?.prepareContext(messages, signal) ?? Promise.resolve([]),
      committed: messages => options.skills?.committed(messages),
      finishTurn: () => {
        try { options.skills?.finishTurn(); }
        finally { releaseAttachments?.(); releaseAttachments = undefined; attachmentTurnStart = undefined; }
      },
    },
    modelAdapter: adapter,
    model: route.model,
    tools: options.tools,
    prepareTools: options.prepareTools,
    cliName: "laohuang",
    cliVersion: options.version,
    provider: route.provider,
    baseUrl: route.baseUrl,
    projectRoot: options.projectRoot,
    startupCwd: options.startupCwd,
    conversationHistory: activeConversationHistory,
    contextGovernor: {
      prepare: async ({ tools, projectTools, reserveTokens, pendingToolCall }) => {
        const history = options.sessionController.history;
        if (history === null) {
          return { messages: [], contextTokens: 0, contextWindow: 0, hardInputLimit: 0 };
        }
        const entries = history.entries();
        const pendingAssistant = pendingToolCall
          ? [...entries].reverse().find((entry) => entry.entryType === "assistant_message")
          : undefined;
        const prepared = await createGovernor(history).prepare({
          protectedFromSeq: attachmentTurnStart,
          entries: entries.filter((entry) => entry !== pendingAssistant),
          currentProvider: route.provider,
          currentModel: route.model,
          tools,
          projectTools,
          reserveTokens,
          budget: modelBudget(selectedModel),
          policy: defaultContextPolicy(),
        });
        return {
          messages: prepared.messages,
          contextTokens: prepared.tokens,
          contextWindow: selectedModel.contextWindow,
          hardInputLimit: selectedModel.contextWindow - selectedModel.maxTokens,
        };
      },
    },
  });
  const classifier = new SmallModelSemanticClassifier({
    modelRuntime,
    route,
  });
  const session = new AgentSession(agent, {
    sessionId: options.sessionController.currentSessionId ?? undefined,
    semanticClassifier: classifier,
    commandDispatcher: options.commandDispatcher ?? null,
  });
  const recorder = new SessionRecorder({
    eventBus: session.eventBus,
    journal: () => options.sessionController.currentJournal,
  });

  const projectTools = (messages: readonly ModelMessage[]) => new ToolSelection().prepare(
    options.tools,
    messages.map((message) => message.role === "system" || message.role === "user" ? message : {}),
  ).view.definitions;

  const refreshContextUsage = (): void => {
    const notify = options.presentation?.contextUsageChanged;
    if (notify === undefined) {
      return;
    }
    notify({
      contextTokens: options.sessionController.history === null ? 0 : options.sessionController.history.contextTokens,
      contextWindow: selectedModel.contextWindow,
    });
  };

  let unsubscribeHistory: (() => void) | undefined;
  const refreshSession = (): void => {
    const sessionId = options.sessionController.currentSessionId;
    const history = options.sessionController.history;
    if (sessionId === null || history === null) {
      throw new Error("no active session");
    }
    unsubscribeHistory?.();
    unsubscribeHistory = history.onChange(() => {
      if (options.sessionController.history === history) refreshContextUsage();
    });
    session.setSessionId(sessionId);
    options.skills?.selectSession(sessionId);
    options.presentation?.sessionChanged?.(sessionId);
    let entries = history.entries();
    if (entries.length === 0) {
      const system = agent.messages.find(
        (message: ModelMessage) => message.role === "system",
      );
      if (system !== undefined) {
        history.appendSystemContext({ message: system, cwd: options.startupCwd });
        agent.messages = [system];
        entries = history.entries();
      }
    } else {
      agent.messages = [
        ...new ContextBuilder().build({
          entries,
          currentProvider: route.provider,
          currentModel: route.model,
        }).messages,
      ];
    }
    options.presentation?.historyChanged?.(entries);
    refreshContextUsage();
  };

  options.sessionController.setCompactor(async () => {
    const history = activeHistory(options.sessionController);
    const result = await createGovernor(history).compact({
      entries: history.entries(),
      currentProvider: route.provider,
      currentModel: route.model,
      tools: options.tools.definitions,
      projectTools,
      budget: modelBudget(selectedModel),
      policy: defaultContextPolicy(),
      trigger: "manual",
    });
    agent.messages = [
      ...new ContextBuilder().build({
        entries: history.entries(),
        currentProvider: route.provider,
        currentModel: route.model,
      }).messages,
    ];
    options.presentation?.historyChanged?.(history.entries());
    refreshContextUsage();
    return result;
  });

  const runtime: SessionRuntime = {
    agent,
    session,
    classifier,
    get route() {
      return { ...route };
    },
    refreshSession,
    switchModel(nextRoute) {
      selectedModel = modelInfo(options.catalog, nextRoute);
      route = { ...nextRoute };
      if (
        agent.provider !== route.provider ||
        agent.model !== route.model ||
        agent.baseUrl !== route.baseUrl
      ) {
        agent.switchModel(route);
      }
      classifier.configure(route);
      refreshContextUsage();
    },
    compact: () => options.sessionController.compact(),
    refreshContextUsage,
    async close() {
      unsubscribeHistory?.();
      try {
        await recorder.close();
      } finally {
        options.sessionController.setCompactor(null);
        await options.sessionController.close();
      }
    },
  };
  refreshSession();
  return runtime;
}

function activeHistory(controller: SessionController): ConversationHistory {
  const history = controller.history;
  if (history === null) {
    throw new Error("no active session");
  }
  return history;
}

function modelInfo(catalog: ModelCatalog, route: SessionRoute): ModelInfo {
  const model = catalog.getModel(route.provider, route.model);
  if (model === undefined) {
    throw new Error(`Unknown model: ${route.provider}/${route.model}`);
  }
  return model;
}

function modelBudget(model: ModelInfo) {
  return {
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxTokens,
  };
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
