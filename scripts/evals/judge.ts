import type { ApiProvider, CallApiContextParams, CallApiOptionsParams, ProviderResponse } from "promptfoo";
import { readKimiKey, redact } from "./sandbox.ts";

/** Transport only. The full prompt and rubric come from promptfoo, unchanged. */
export default class KimiJudge implements ApiProvider {
  id(): string { return "kimi-code:official-grading"; }
  async callApi(prompt: string, _context?: CallApiContextParams, options?: CallApiOptionsParams): Promise<ProviderResponse> {
    const key = readKimiKey();
    try {
      const response = await fetch("https://api.kimi.com/coding/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key,
          "anthropic-version": "2023-06-01", "user-agent": "KimiCLI/1.5" },
        body: JSON.stringify({ model: "kimi-for-coding", max_tokens: 8192,
          messages: [{ role: "user", content: prompt }], stream: false }),
        signal: options?.abortSignal ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000),
      });
      if (!response.ok) return { error: `Kimi official grader HTTP ${response.status}` };
      const result = await response.json() as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };
      const output = result.content?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("") ?? "";
      if (!output.trim()) return { error: "Kimi official grader returned no visible text" };
      const promptTokens = result.usage?.input_tokens ?? 0, completion = result.usage?.output_tokens ?? 0;
      const cached = result.usage?.cache_read_input_tokens ?? 0;
      return { output: redact(output, [key]), tokenUsage: { prompt: promptTokens, completion, cached,
        total: promptTokens + completion + cached + (result.usage?.cache_creation_input_tokens ?? 0) } };
    } catch { return { error: "Kimi official grader request failed or timed out" }; }
  }
}
