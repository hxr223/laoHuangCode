import {
  ModelError,
  ModelStreamCancelled,
  type AssistantContentBlock,
  type ModelEvent,
  type ModelFinishReason,
  type ModelRequest,
  type ModelResult,
  type ModelUsage,
} from "@laohuang/llm";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  ToolCall as PiToolCall,
  Usage as PiUsage,
} from "@earendil-works/pi-ai";
import { toReplayEnvelope } from "./replay.ts";

const DSML_TOOL_ENVELOPE =
  /^<｜｜DSML｜｜tool_calls>\s*<｜｜DSML｜｜invoke\b[\s\S]*<\/｜｜DSML｜｜invoke>\s*<\/｜｜DSML｜｜tool_calls>$/;

export async function consumePiEvents(
  events: AsyncIterable<AssistantMessageEvent>,
  request: ModelRequest,
  emit?: (event: ModelEvent) => void,
): Promise<ModelResult> {
  let terminal = false;
  let hadDelta = false;
  for await (const event of events) {
    ensureActive(request, hadDelta);
    if (event.type === "text_delta") {
      hadDelta = true;
      emit?.({ type: "text-delta", text: event.delta });
    } else if (event.type === "thinking_delta") {
      hadDelta = true;
      emit?.({ type: "reasoning-delta", text: event.delta });
    } else if (event.type === "toolcall_delta") {
      hadDelta = true;
      emit?.({
        type: "tool-call-delta",
        index: event.contentIndex,
        id: readPartialToolCall(event.partial, event.contentIndex)?.id ?? "",
        name: readPartialToolCall(event.partial, event.contentIndex)?.name,
        argumentsDelta: event.delta,
      });
    } else if (event.type === "done") {
      terminal = true;
      emit?.({ type: "response-validating" });
      ensureActive(request, hadDelta);
      return resultFromMessage(request, event.message, hadDelta);
    } else if (event.type === "error") {
      terminal = true;
      if (event.reason === "aborted" || event.error.stopReason === "aborted") {
        throw new ModelStreamCancelled(
          event.error.errorMessage ?? "model request aborted",
        );
      }
      throw new ModelError(event.error.errorMessage ?? "pi-ai model request failed", {
        kind: "retryable",
        hadDelta,
      });
    }
  }
  if (!terminal) {
    throw new ModelError("pi-ai stream ended without a terminal event", {
      kind: "protocol",
      hadDelta,
    });
  }
  throw new ModelError("pi-ai stream ended after terminal event", {
    kind: "protocol",
    hadDelta,
  });
}

function resultFromMessage(
  request: ModelRequest,
  message: AssistantMessage,
  hadDelta: boolean,
): ModelResult {
  const finishReason = finishReasonOf(message);
  const content = contentOf(message, finishReason, hadDelta);
  rejectTextualDsml(request, content, hadDelta);
  return {
    requestId: request.requestId ?? "",
    finishReason,
    usage: usageOf(message.usage),
    message: {
      role: "assistant",
      provider: request.provider,
      model: request.model,
      content,
      replay: toReplayEnvelope(message),
    },
  };
}

function finishReasonOf(message: AssistantMessage): ModelFinishReason {
  if (message.stopReason === "stop") return "stop";
  if (message.stopReason === "toolUse") return "tool-calls";
  if (message.stopReason === "length") return "max-tokens";
  if (message.stopReason === "aborted") {
    throw new ModelStreamCancelled(message.errorMessage ?? "model request aborted");
  }
  throw new ModelError(message.errorMessage ?? "pi-ai model request failed", {
    kind: "retryable",
  });
}

function contentOf(
  message: AssistantMessage,
  finishReason: ModelFinishReason,
  hadDelta: boolean,
): readonly AssistantContentBlock[] {
  const blocks = message.content.map((block): AssistantContentBlock => {
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "thinking") {
      return { type: "reasoning", text: block.thinking };
    }
    validateToolCall(block, hadDelta);
    return {
      type: "tool-call",
      call: {
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.arguments),
      },
    };
  });
  if (finishReason === "tool-calls") {
    const toolCalls = blocks.filter((block) => block.type === "tool-call");
    if (toolCalls.length === 0) {
      throw new ModelError("toolUse response contained no tool calls", {
        kind: "protocol",
        hadDelta,
      });
    }
  }
  if (finishReason === "stop" && blocks.length === 0) {
    throw new ModelError("stop response contained no visible content", {
      kind: "protocol",
      hadDelta,
    });
  }
  return blocks;
}

function validateToolCall(block: PiToolCall, hadDelta: boolean): void {
  if (block.id.length === 0 || block.name.length === 0) {
    throw new ModelError("tool call is missing an id or name", {
      kind: "protocol",
      hadDelta,
    });
  }
  if (
    typeof block.arguments !== "object" ||
    block.arguments === null ||
    Array.isArray(block.arguments)
  ) {
    throw new ModelError("tool call arguments must be a JSON object", {
      kind: "protocol",
      hadDelta,
    });
  }
}

function usageOf(usage: PiUsage): ModelUsage {
  const result: ModelUsage = {
    inputTokens: finiteToken(usage.input, "input"),
    outputTokens: finiteToken(usage.output, "output"),
    cacheReadTokens: finiteToken(usage.cacheRead, "cacheRead"),
    cacheWriteTokens: finiteToken(usage.cacheWrite, "cacheWrite"),
    ...(usage.reasoning === undefined
      ? {}
      : { reasoningTokens: finiteToken(usage.reasoning, "reasoning") }),
  };
  return result;
}

function finiteToken(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new ModelError(`invalid usage token count: ${field}`, {
      kind: "protocol",
    });
  }
  return value;
}

function rejectTextualDsml(
  request: ModelRequest,
  content: readonly AssistantContentBlock[],
  hadDelta: boolean,
): void {
  const text = content
    .filter((block): block is Extract<AssistantContentBlock, { type: "text" }> =>
      block.type === "text",
    )
    .map((block) => block.text)
    .join("");
  if (DSML_TOOL_ENVELOPE.test(text.trim())) {
    throw new ModelError(
      `provider ${request.provider}/${request.model} returned textual tool protocol`,
      { kind: "protocol", hadDelta: hadDelta || text.length > 0 },
    );
  }
}

function readPartialToolCall(
  message: AssistantMessage,
  index: number,
): PiToolCall | undefined {
  const block = message.content[index];
  return block?.type === "toolCall" ? block : undefined;
}

function ensureActive(request: ModelRequest, hadDelta: boolean): void {
  if (
    request.requestId !== undefined &&
    request.isRequestActive !== undefined &&
    !request.isRequestActive(request.requestId)
  ) {
    throw new ModelStreamCancelled("stale model request", { cause: hadDelta });
  }
  if (request.cancelToken?.isCancelled()) {
    throw new ModelStreamCancelled(request.cancelToken.reason || "cancelled");
  }
}
