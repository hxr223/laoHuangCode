import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { ModelError } from "@laohuang/llm";

function partial<T extends TSchema>(schema: T) {
  return Type.Partial(schema, { additionalProperties: false });
}

const text = Type.String({ minLength: 1, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const strings = Type.Array(text);
const positive = Type.Integer({ minimum: 1 });
const rate = Type.Number({ minimum: 0 });
const rates = { input: rate, output: rate, cacheRead: rate, cacheWrite: rate };
const cost = Type.Object({
  ...rates,
  tiers: Type.Optional(Type.Array(Type.Object({ ...rates, inputTokensAbove: rate }, { additionalProperties: false }))),
}, { additionalProperties: false });
const affinity = Type.Union([Type.Literal("openai"), Type.Literal("openai-nosession"), Type.Literal("openrouter")]);
const templateValue = Type.Union([
  Type.String(), Type.Number(), Type.Boolean(), Type.Null(),
  Type.Object({
    $var: Type.Union([Type.Literal("thinking.enabled"), Type.Literal("thinking.effort"), Type.Literal("thinking.budget")]),
    omitWhenOff: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
]);
const percentiles = Type.Union([Type.Number(), partial(Type.Object({
  p50: Type.Number(), p75: Type.Number(), p90: Type.Number(), p99: Type.Number(),
}, { additionalProperties: false }))]);

export const completionsCompat = partial(Type.Object({
  supportsStore: Type.Boolean(),
  supportsDeveloperRole: Type.Boolean(),
  supportsReasoningEffort: Type.Boolean(),
  supportsUsageInStreaming: Type.Boolean(),
  supportsFinishReason: Type.Boolean(),
  maxTokensField: Type.Union([Type.Literal("max_completion_tokens"), Type.Literal("max_tokens")]),
  requiresToolResultName: Type.Boolean(),
  requiresAssistantAfterToolResult: Type.Boolean(),
  requiresThinkingAsText: Type.Boolean(),
  requiresReasoningContentOnAssistantMessages: Type.Boolean(),
  thinkingFormat: Type.Union([
    Type.Literal("openai"), Type.Literal("openrouter"), Type.Literal("deepseek"),
    Type.Literal("together"), Type.Literal("baseten"), Type.Literal("zai"), Type.Literal("qwen"),
    Type.Literal("chat-template"), Type.Literal("qwen-chat-template"), Type.Literal("string-thinking"), Type.Literal("ant-ling"),
  ]),
  chatTemplateKwargs: Type.Record(Type.String(), templateValue),
  chatTemplateArgs: Type.Record(Type.String(), templateValue),
  openRouterRouting: partial(Type.Object({
    allow_fallbacks: Type.Boolean(), require_parameters: Type.Boolean(),
    data_collection: Type.Union([Type.Literal("deny"), Type.Literal("allow")]),
    zdr: Type.Boolean(), enforce_distillable_text: Type.Boolean(),
    order: strings, only: strings, ignore: strings, quantizations: strings,
    sort: Type.Union([Type.String(), partial(Type.Object({
      by: Type.String(), partition: Type.Union([Type.String(), Type.Null()]),
    }, { additionalProperties: false }))]),
    max_price: partial(Type.Object({
      prompt: Type.Union([rate, Type.String()]), completion: Type.Union([rate, Type.String()]),
      image: Type.Union([rate, Type.String()]), audio: Type.Union([rate, Type.String()]), request: Type.Union([rate, Type.String()]),
    }, { additionalProperties: false })),
    preferred_min_throughput: percentiles, preferred_max_latency: percentiles,
  }, { additionalProperties: false })),
  vercelGatewayRouting: partial(Type.Object({ only: strings, order: strings }, { additionalProperties: false })),
  zaiToolStream: Type.Boolean(),
  thinkingTokenBudgetField: Type.Union([Type.Literal("thinking_token_budget"), Type.Literal("thinking_budget"), Type.Literal("thinking_budget_tokens")]),
  supportsThinkingTokenBudget: Type.Boolean(), supportsOpenAIGrammarTools: Type.Boolean(),
  supportsStrictMode: Type.Boolean(), cacheControlFormat: Type.Literal("anthropic"),
  sendSessionAffinityHeaders: Type.Boolean(), deferredToolsMode: Type.Literal("kimi"),
  sessionAffinityFormat: affinity, supportsLongCacheRetention: Type.Boolean(), vllmPriority: Type.Number(),
}, { additionalProperties: false }));

export const responsesCompat = partial(Type.Object({
  supportsDeveloperRole: Type.Boolean(), sessionAffinityFormat: affinity,
  supportsLongCacheRetention: Type.Boolean(), supportsStrictMode: Type.Boolean(),
  supportsOpenAIGrammarTools: Type.Boolean(), supportsAdditionalTools: Type.Boolean(),
  supportsToolSearch: Type.Boolean(), supportsExplicitPromptCacheMode: Type.Boolean(),
  supportsMaxOutputTokens: Type.Boolean(),
}, { additionalProperties: false }));

export const anthropicCompat = partial(Type.Object({
  supportsEagerToolInputStreaming: Type.Boolean(), supportsLongCacheRetention: Type.Boolean(),
  sendSessionAffinityHeaders: Type.Boolean(), supportsCacheControlOnTools: Type.Boolean(),
  supportsTemperature: Type.Boolean(), forceAdaptiveThinking: Type.Boolean(),
  allowEmptySignature: Type.Boolean(), supportsStrictTools: Type.Boolean(),
  supportsMidConvoEffort: Type.Boolean(), supportsToolReferences: Type.Boolean(),
  allowedFallbackModels: Type.Array(Type.Object({ provider: text, model: text, cost }, { additionalProperties: false })),
}, { additionalProperties: false }));

const api = Type.Union([
  Type.Literal("openai-completions"), Type.Literal("openai-responses"),
  Type.Literal("anthropic-messages"), Type.Literal("google-generative-ai"),
]);
const compat = Type.Record(Type.String(), Type.Unknown());
const headers = Type.Record(Type.String({ pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" }), text, { additionalProperties: false });
const level = Type.Union([text, Type.Null()]);
const model = Type.Object({
  id: text,
  name: Type.Optional(text), api: Type.Optional(api), baseUrl: Type.Optional(text),
  reasoning: Type.Optional(Type.Boolean()),
  thinkingLevelMap: Type.Optional(partial(Type.Object({
    off: level, minimal: level, low: level, medium: level, high: level, xhigh: level, max: level,
  }, { additionalProperties: false }))),
  input: Type.Optional(Type.Array(Type.Union([Type.Literal("text"), Type.Literal("image")]), { minItems: 1, uniqueItems: true })),
  contextWindow: Type.Optional(positive), maxTokens: Type.Optional(positive),
  cost: Type.Optional(partial(cost)), headers: Type.Optional(headers),
  compat: Type.Optional(compat), samplingParams: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });

const provider = Type.Object({
  name: Type.Optional(text), api: Type.Optional(api), baseUrl: Type.Optional(text),
  apiKeyEnv: Type.Optional(Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" })),
  headers: Type.Optional(headers), compat: Type.Optional(compat),
  models: Type.Optional(Type.Array(model)),
}, { additionalProperties: false });
const schema = Type.Object({
  providers: Type.Record(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]*$" }), provider, { additionalProperties: false }),
}, { additionalProperties: false });

export type CustomModel = Static<typeof model>;
export type CustomProvider = Static<typeof provider>;
export type CustomModels = Static<typeof schema>;

export function customModelError(message: string): never {
  throw new ModelError(`Custom models: ${message}`, { kind: "protocol" });
}

export function parseCustomModels(value: unknown): CustomModels {
  if (value === undefined) return { providers: {} };
  if (!Check(schema, value)) {
    customModelError("invalid configuration; check providers, model fields and types. Use apiKeyEnv or /login for credentials; literal apiKey and shell commands are not supported.");
  }
  for (const id of Object.keys(value.providers)) {
    if (["constructor", "prototype", "__proto__"].includes(id)) {
      customModelError("reserved provider ID");
    }
  }
  return structuredClone(value);
}
