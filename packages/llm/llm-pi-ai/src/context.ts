import { ModelError, type ModelMessage, type ModelRequest } from "@laohuang/llm";
import type {
  Context as PiContext,
  Message as PiMessage,
  Tool as PiTool,
  TextContent,
  ImageContent,
} from "@earendil-works/pi-ai";
import type { ToolSpec } from "@laohuang/tools";
import { toPiAssistant } from "./replay.ts";

function toolsOf(request: ModelRequest): PiTool[] | undefined {
  if (request.tools.length === 0) {
    return undefined;
  }
  return request.tools.map(toolOf);
}

export function toPiContext(request: ModelRequest, attachments?: ReadonlyMap<ModelMessage, readonly (TextContent | ImageContent)[]>): PiContext {
  const systems = request.messages.filter(
    (message): message is Extract<ModelMessage, { role: "system" }> =>
      message.role === "system" && message.toolDefinitions === undefined,
  );
  if (systems.length > 1) {
    throw new ModelError("model history contains more than one system message", {
      kind: "protocol",
    });
  }
  const messages = request.messages
    .filter((message) => message.role !== "system")
    .map((message) => toPiMessage(message, request.provider, request.model, attachments?.get(message)));
  const tools = toolsOf(request);
  return {
    ...(systems[0] === undefined ? {} : { systemPrompt: systems[0].content }),
    messages,
    ...(tools === undefined ? {} : { tools }),
  };
}

function toPiMessage(
  message: Exclude<ModelMessage, { role: "system" }>,
  provider: string,
  model: string,
  attachments?: readonly (TextContent | ImageContent)[],
): PiMessage {
  if ((message.role === "user" || message.role === "tool-result") && message.attachments?.length && attachments === undefined) {
    throw new ModelError("Attachments must be prepared before serializing model context", { kind: "protocol" });
  }
  if (message.role === "user") {
    return { role: "user", content: attachments?.length ? [{ type: "text", text: message.content }, ...attachments] : message.content, timestamp: 0 };
  }
  if (message.role === "assistant") {
    return toPiAssistant(message, { provider, model });
  }
  return {
    role: "toolResult",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: [{ type: "text", text: message.content || "(no output)" }, ...(attachments ?? [])],
    isError: message.isError,
    timestamp: 0,
  };
}

function toolOf(spec: ToolSpec): PiTool {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters as PiTool["parameters"],
  };
}
