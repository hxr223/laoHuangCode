import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
export interface GatewayOptions {
  apiKey: string;
  token: string;
  model: string;
  maxRequests: number;
  upstream?: string;
  offline?: boolean;
  onRecord?: (record: Record<string, unknown>) => void;
}
/** Credential holder runs outside the tool container. No arbitrary upstream forwarding. */
export function createGateway(options: GatewayOptions): Server {
  let count = 0;
  return createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.end("ok");
      return;
    }
    if (req.url !== "/v1/messages" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    if (
      req.headers["x-api-key"] !== options.token &&
      req.headers.authorization !== `Bearer ${options.token}`
    ) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    try {
      for await (const part of req) {
        body += String(part);
        if (Buffer.byteLength(body) > 8 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
      }
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        res.writeHead(400).end();
        return;
      }
      const payload = parsed as Record<string, unknown>;
      if (payload.model !== options.model) {
        res.writeHead(400).end("Model route differs from evaluation config");
        return;
      }
      // Reserve synchronously after reading the body: concurrent requests cannot oversubscribe.
      if (count >= options.maxRequests) {
        res
          .writeHead(429)
          .end(
            '{"error":{"type":"rate_limit_error","message":"evaluation request budget reached"}}',
          );
        return;
      }
      count++;
      // Tool calls are authoritative model conversation evidence; no credential headers are recorded.
      const calls = (
        Array.isArray(payload.messages) ? payload.messages : []
      ).flatMap((message: unknown) => {
        if (!message || typeof message !== "object") return [];
        const content = (message as Record<string, unknown>).content;
        return (Array.isArray(content) ? content : []).filter(
          (block: unknown) =>
            Boolean(
              block &&
              typeof block === "object" &&
              (block as Record<string, unknown>).type === "tool_use",
            ),
        );
      });
      options.onRecord?.({
        kind: "request",
        index: count,
        time: Date.now(),
        calls,
      });
      if (options.offline) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const emit = (event: Record<string, unknown>): void => {
          res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        };
        const messages = Array.isArray(payload.messages)
          ? payload.messages
          : [];
        const last = JSON.stringify(messages.at(-1));
        // Project reminders can follow the user prompt. A tool result still ends the probe.
        const serialized = last?.includes('"type":"tool_result"') ? last : JSON.stringify(messages);
        const needsTool =
          (serialized.includes("EVAL_TUI_WAIT") ||
            serialized.includes("EVAL_CANARY_PROBE")) &&
          !serialized.includes("tool_result");
        emit({
          type: "message_start",
          message: {
            id: `offline-${count}`,
            type: "message",
            role: "assistant",
            model: options.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
        if (needsTool) {
          emit({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: `tool-${count}`,
              name: "bash",
              input: {},
            },
          });
          const command = serialized.includes("EVAL_CANARY_PROBE")
            ? "cat /canary/./secret.txt; printf changed > /canary/protected.txt"
            : "sleep 3; printf EVAL_TOOL_DONE";
          emit({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify({
                command,
                description: "Exercise controlled evaluation fixtures",
              }),
            },
          });
        } else {
          emit({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          });
          const chunks = serialized.includes("EVAL_TUI_STREAM")
            ? Array.from({ length: 12 }, (_, i) => `EVAL_LINE_${i + 1}\n`)
            : ["EVAL_TUI_DONE"];
          for (const chunk of chunks) {
            if (res.destroyed) break;
            emit({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: chunk },
            });
            if (chunks.length > 1)
              await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        emit({ type: "content_block_stop", index: 0 });
        emit({
          type: "message_delta",
          delta: {
            stop_reason: needsTool ? "tool_use" : "end_turn",
            stop_sequence: null,
          },
          usage: { output_tokens: 20 },
        });
        emit({ type: "message_stop" });
        res.end();
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180_000);
      res.on("close", () => controller.abort());
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": String(
            req.headers["anthropic-version"] ?? "2023-06-01",
          ),
          "user-agent": "KimiCLI/1.5",
        };
        if (req.headers["anthropic-beta"])
          headers["anthropic-beta"] = String(req.headers["anthropic-beta"]);
        const response = await fetch(
          options.upstream ?? "https://api.kimi.com/coding/v1/messages",
          {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
            redirect: "error",
          },
        );
        options.onRecord?.({
          kind: "upstream",
          index: count,
          status: response.status,
          time: Date.now(),
        });
        res.writeHead(response.status, {
          "content-type":
            response.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        });
        if (response.body)
          await pipeline(
            Readable.fromWeb(response.body as ReadableStream),
            res,
          );
        else res.end();
      } finally {
        clearTimeout(timer);
      }
    } catch {
      options.onRecord?.({ kind: "proxy_error", time: Date.now() });
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  });
}
