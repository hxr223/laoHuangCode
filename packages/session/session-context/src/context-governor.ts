import {
  ModelError,
  modelErrorKind,
  type ModelMessage,
} from "@laohuang/llm";
import type { ToolSpec } from "@laohuang/tools";
import type {
  CompactionEntry,
  CompactionPayload,
  SessionEntry,
} from "@laohuang/session-store";

import { ContextBuilder, type BuiltContext } from "./context-builder.ts";
import {
  DefaultTokenEstimator,
  fingerprintContextPart,
  type TokenEstimator,
  type UsageAnchor,
} from "./token-estimator.ts";
import { selectCompactionPlan, serializeConversation } from "./compaction.ts";

export interface ModelBudget {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

export interface ContextPolicy {
  readonly auto: boolean;
  readonly thresholdRatio: number;
  readonly retainRatio: number;
  readonly retainTokens?: number;
  readonly maxSummaryTokens: number;
  readonly safetyRatio: number;
}

export interface CalculatedModelBudget {
  readonly hardInputLimit: number;
  readonly safetyTokens: number;
  readonly autoTrigger: number;
  readonly retainTokens: number;
}

export interface PrepareContextInput {
  readonly reserveTokens?: number;
  readonly projectTools?: (messages: readonly ModelMessage[]) => readonly ToolSpec[];
  readonly entries: readonly SessionEntry[];
  readonly currentProvider: string;
  readonly currentModel: string;
  readonly tools: readonly ToolSpec[];
  readonly budget: ModelBudget;
  readonly policy: ContextPolicy;
  readonly anchor?: UsageAnchor | null;
}

export interface PreparedContext {
  readonly built: BuiltContext;
  readonly messages: readonly ModelMessage[];
  readonly compacted: boolean;
  readonly tokens: number;
}

export interface ManualCompactionInput extends PrepareContextInput {
  readonly trigger: CompactionPayload["trigger"];
}

export interface CompactionResult {
  readonly entry: CompactionEntry;
}

export interface SummaryResult {
  readonly summary: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ContextGovernorOptions {
  readonly builder?: ContextBuilder;
  readonly estimator?: TokenEstimator;
  readonly summarize: (input: { serialized: string; maxSummaryTokens: number }) => Promise<SummaryResult>;
  readonly appendCompaction: (payload: CompactionPayload) => CompactionEntry;
}

export class ContextBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetError";
  }
}

export class ContextGovernor {
  readonly #builder: ContextBuilder;
  readonly #estimator: TokenEstimator;
  readonly #summarize: ContextGovernorOptions["summarize"];
  readonly #appendCompaction: ContextGovernorOptions["appendCompaction"];

  constructor(options: ContextGovernorOptions) {
    this.#builder = options.builder ?? new ContextBuilder();
    this.#estimator = options.estimator ?? new DefaultTokenEstimator();
    this.#summarize = options.summarize;
    this.#appendCompaction = options.appendCompaction;
  }

  async prepare(input: PrepareContextInput): Promise<PreparedContext> {
    let built = this.#builder.build(input);
    let tokens = this.measure(input, built);
    const calculated = calculateModelBudget({ budget: input.budget, policy: input.policy });
    if (!input.policy.auto || tokens <= calculated.autoTrigger) {
      if (tokens > calculated.hardInputLimit) throw new ContextBudgetError("context exceeds hard input limit");
      return { built, messages: built.messages, compacted: false, tokens };
    }
    const result = await this.compact({ ...input, trigger: "automatic" });
    const entries = [...input.entries, result.entry];
    built = this.#builder.build({ ...input, entries });
    tokens = this.measure({ ...input, entries }, built);
    if (tokens > calculated.hardInputLimit) {
      throw new ContextBudgetError("context remains over hard input limit after compaction");
    }
    return { built, messages: built.messages, compacted: true, tokens };
  }

  async compact(input: ManualCompactionInput): Promise<CompactionResult> {
    const calculated = calculateModelBudget({ budget: input.budget, policy: input.policy });
    const plan = selectCompactionPlan({
      entries: input.entries,
      // A search preflight reserves the pending call/result/definition unit.
      // Keep the latest completed unit and summarize older units to make room.
      retainTokens: input.reserveTokens === undefined ? calculated.retainTokens : 1,
      estimator: this.#estimator,
    });
    if (input.trigger === "manual" && plan.summarizedEntries.length === 0) {
      throw new Error("No messages to compact in current history.");
    }
    const summarizedFromSeq = plan.summarizedEntries[0]?.seq ?? 1;
    const summarizedThroughSeq = plan.summarizedEntries.at(-1)?.seq ?? Math.max(0, summarizedFromSeq - 1);
    const activeCompaction = [...input.entries].reverse().find(
      (entry): entry is CompactionEntry => entry.entryType === "compaction",
    );
    const messagesBefore = this.#builder.build(input).messages;
    const tokensBefore = this.#estimator.estimateMessages(messagesBefore)
      + this.#estimator.estimateTools(input.projectTools?.(messagesBefore) ?? input.tools);
    const summary = plan.summarizedEntries.length === 0
      ? {
          summary: "No prior conversation needed compaction.",
          inputTokens: 0,
          outputTokens: 0,
        }
      : await this.#summarize({
          serialized: serializeConversation(plan.summarizedEntries),
          maxSummaryTokens: input.policy.maxSummaryTokens,
        });
    const payload: CompactionPayload = {
      summary: summary.summary,
      summarizedFromSeq,
      summarizedThroughSeq,
      retainedFromSeq: plan.retainedFromSeq,
      ...(activeCompaction === undefined ? {} : { supersedesCompactionId: activeCompaction.id }),
      tokensBefore,
      retainedTokens: calculated.retainTokens,
      summaryInputTokens: summary.inputTokens,
      summaryOutputTokens: summary.outputTokens,
      provider: input.currentProvider,
      model: input.currentModel,
      trigger: input.trigger,
    };
    return { entry: this.#appendCompaction(payload) };
  }

  async completeWithOverflowRecovery<T>(
    input: PrepareContextInput,
    send: (prepared: PreparedContext) => Promise<T>,
  ): Promise<T> {
    let prepared = await this.prepare(input);
    try {
      return await send(prepared);
    } catch (error) {
      if (!(error instanceof ModelError) || modelErrorKind(error) !== "context_overflow" || error.hadDelta) {
        throw error;
      }
    }
    const compaction = await this.compact({ ...input, trigger: "provider_overflow" });
    prepared = await this.prepare({ ...input, entries: [...input.entries, compaction.entry] });
    return await send(prepared);
  }

  private measure(input: PrepareContextInput, built: BuiltContext): number {
    const tools = input.projectTools?.(built.messages) ?? input.tools;
    return this.#estimator.measure({
      messages: built.messages,
      tools,
      entries: input.entries,
      anchor: input.anchor ?? null,
      provider: input.currentProvider,
      model: input.currentModel,
      systemFingerprint: fingerprintContextPart(
        built.messages.find((message) => message.role === "system") ?? null,
      ),
      projectInstructionsFingerprint: fingerprintContextPart(
        built.messages.filter((message, index) => index > 0 && message.role === "user"),
      ),
      toolsFingerprint: fingerprintContextPart(tools),
    }).totalTokens + (input.reserveTokens ?? 0);
  }
}

export function calculateModelBudget(input: {
  readonly budget: ModelBudget;
  readonly policy: ContextPolicy;
}): CalculatedModelBudget {
  const hardInputLimit = input.budget.contextWindow - input.budget.maxOutputTokens;
  const safetyTokens = Math.ceil(input.budget.contextWindow * input.policy.safetyRatio);
  const autoTrigger = Math.min(
    Math.floor(input.budget.contextWindow * input.policy.thresholdRatio),
    hardInputLimit - safetyTokens,
  );
  const retainTokens = input.policy.retainTokens ??
    Math.floor(input.budget.contextWindow * input.policy.retainRatio);
  return { hardInputLimit, safetyTokens, autoTrigger, retainTokens };
}
