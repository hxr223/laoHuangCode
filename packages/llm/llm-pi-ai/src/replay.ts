import {
  type AssistantContentBlock,
  type AssistantModelMessage,
  type ModelReplayEnvelope,
} from "@laohuang/llm";
import { ModelError } from "@laohuang/llm";
import type {
  Api,
  AssistantMessage,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall as PiToolCall,
} from "@earendil-works/pi-ai";

export interface PiReplayTextBlock {
  readonly type: "text";
  readonly textSignature?: string;
}

export interface PiReplayThinkingBlock {
  readonly type: "reasoning";
  readonly thinkingSignature?: string;
  readonly redacted?: boolean;
}

export interface PiReplayToolCallBlock {
  readonly type: "tool-call";
  readonly thoughtSignature?: string;
}

export type PiReplayBlock =
  | PiReplayTextBlock
  | PiReplayThinkingBlock
  | PiReplayToolCallBlock;

export interface PiReplayStateV1 {
  readonly api: string;
  readonly provider: string;
  readonly model: string;
  readonly responseModel?: string;
  readonly responseId?: string;
  readonly stopReason: string;
  readonly blocks: readonly PiReplayBlock[];
}

export interface PiRoute {
  readonly provider: string;
  readonly model: string;
}

export function toReplayEnvelope(message: AssistantMessage): ModelReplayEnvelope {
  return {
    adapter: "pi-ai",
    version: 1,
    state: {
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...(message.responseModel === undefined
        ? {}
        : { responseModel: message.responseModel }),
      ...(message.responseId === undefined ? {} : { responseId: message.responseId }),
      stopReason: message.stopReason,
      blocks: message.content.map(replayBlockOf),
    },
  };
}

export function toPiAssistant(
  message: AssistantModelMessage,
  route: PiRoute,
): AssistantMessage {
  const replay = validReplayState(message, route);
  const content = message.content.map((block, index) =>
    toPiContentBlock(block, replay?.blocks[index]),
  );
  return {
    role: "assistant",
    api: (replay?.api ?? "pi-ai") as Api,
    provider: route.provider,
    model: route.model,
    ...(replay?.responseModel === undefined
      ? {}
      : { responseModel: replay.responseModel }),
    ...(replay?.responseId === undefined ? {} : { responseId: replay.responseId }),
    usage: zeroUsage(),
    stopReason: (replay?.stopReason ?? "stop") as StopReason,
    timestamp: 0,
    content,
  };
}

function replayBlockOf(
  block: AssistantMessage["content"][number],
): PiReplayBlock {
  if (block.type === "text") {
    return {
      type: "text",
      ...(block.textSignature === undefined
        ? {}
        : { textSignature: block.textSignature }),
    };
  }
  if (block.type === "thinking") {
    return {
      type: "reasoning",
      ...(block.thinkingSignature === undefined
        ? {}
        : { thinkingSignature: block.thinkingSignature }),
      ...(block.redacted === undefined ? {} : { redacted: block.redacted }),
    };
  }
  return {
    type: "tool-call",
    ...(block.thoughtSignature === undefined
      ? {}
      : { thoughtSignature: block.thoughtSignature }),
  };
}

function toPiContentBlock(
  block: AssistantContentBlock,
  replay: PiReplayBlock | undefined,
): TextContent | ThinkingContent | PiToolCall {
  if (block.type === "text") {
    return {
      type: "text",
      text: block.text,
      ...(replay?.type === "text" && replay.textSignature !== undefined
        ? { textSignature: replay.textSignature }
        : {}),
    };
  }
  if (block.type === "reasoning") {
    return {
      type: "thinking",
      thinking: block.text,
      ...(replay?.type === "reasoning" && replay.thinkingSignature !== undefined
        ? { thinkingSignature: replay.thinkingSignature }
        : {}),
      ...(replay?.type === "reasoning" && replay.redacted !== undefined
        ? { redacted: replay.redacted }
        : {}),
    };
  }
  return {
    type: "toolCall",
    id: block.call.id,
    name: block.call.name,
    arguments: parseToolArguments(block.call.arguments),
    ...(replay?.type === "tool-call" && replay.thoughtSignature !== undefined
      ? { thoughtSignature: replay.thoughtSignature }
      : {}),
  };
}

function validReplayState(
  message: AssistantModelMessage,
  route: PiRoute,
): PiReplayStateV1 | undefined {
  const replay = message.replay;
  if (replay === undefined || replay.adapter !== "pi-ai" || replay.version !== 1) {
    return undefined;
  }
  const state = replay.state;
  if (!isRecord(state)) return undefined;
  if (
    typeof state["api"] !== "string" ||
    state["provider"] !== route.provider ||
    state["model"] !== route.model ||
    typeof state["stopReason"] !== "string"
  ) {
    return undefined;
  }
  if (
    state["responseModel"] !== undefined &&
    typeof state["responseModel"] !== "string"
  ) {
    return undefined;
  }
  if (
    state["responseId"] !== undefined &&
    typeof state["responseId"] !== "string"
  ) {
    return undefined;
  }
  const blocks = state["blocks"];
  if (!Array.isArray(blocks) || blocks.length !== message.content.length) {
    return undefined;
  }
  const replayBlocks: PiReplayBlock[] = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const replayBlock = parseReplayBlock(blocks[index], message.content[index]);
    if (replayBlock === undefined) {
      return undefined;
    }
    replayBlocks.push(replayBlock);
  }
  return {
    api: state["api"],
    provider: route.provider,
    model: route.model,
    ...(typeof state["responseModel"] === "string"
      ? { responseModel: state["responseModel"] }
      : {}),
    ...(typeof state["responseId"] === "string" ? { responseId: state["responseId"] } : {}),
    stopReason: state["stopReason"],
    blocks: replayBlocks,
  };
}

function parseReplayBlock(
  candidate: unknown,
  visible: AssistantContentBlock | undefined,
): PiReplayBlock | undefined {
  if (!isRecord(candidate) || visible === undefined) return undefined;
  if (visible.type === "text" && candidate["type"] === "text") {
    if (
      candidate["textSignature"] !== undefined &&
      typeof candidate["textSignature"] !== "string"
    ) {
      return undefined;
    }
    return {
      type: "text",
      ...(typeof candidate["textSignature"] === "string"
        ? { textSignature: candidate["textSignature"] }
        : {}),
    };
  }
  if (visible.type === "reasoning" && candidate["type"] === "reasoning") {
    if (
      candidate["thinkingSignature"] !== undefined &&
      typeof candidate["thinkingSignature"] !== "string"
    ) {
      return undefined;
    }
    if (candidate["redacted"] !== undefined && typeof candidate["redacted"] !== "boolean") {
      return undefined;
    }
    return {
      type: "reasoning",
      ...(typeof candidate["thinkingSignature"] === "string"
        ? { thinkingSignature: candidate["thinkingSignature"] }
        : {}),
      ...(typeof candidate["redacted"] === "boolean"
        ? { redacted: candidate["redacted"] }
        : {}),
    };
  }
  if (visible.type === "tool-call" && candidate["type"] === "tool-call") {
    if (
      candidate["thoughtSignature"] !== undefined &&
      typeof candidate["thoughtSignature"] !== "string"
    ) {
      return undefined;
    }
    return {
      type: "tool-call",
      ...(typeof candidate["thoughtSignature"] === "string"
        ? { thoughtSignature: candidate["thoughtSignature"] }
        : {}),
    };
  }
  return undefined;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ModelError("tool-call arguments are not valid JSON", {
      kind: "protocol",
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ModelError("tool-call arguments must be a JSON object", {
      kind: "protocol",
    });
  }
  return parsed as Record<string, unknown>;
}

function zeroUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
