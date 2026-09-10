import {
  chownSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createPiAiPlatform } from "@laohuang/llm-pi-ai";
import { CredentialStore, ModelCatalogStore } from "@laohuang/local-config";
import {
  ModelError,
  type ModelAdapter,
  type ModelRequest,
  type ModelResult,
} from "@laohuang/llm";
import { createSessionRuntime } from "../../apps/cli/src/create-session-runtime.ts";
import { SessionController } from "../../apps/cli/src/session-controller.ts";
import { createIsolatedTools } from "./remote-tools.ts";
import { safeFixturePath } from "./verifier.ts";
import type { RunEvidence, Scenario } from "./types.ts";
import { watchCanaries } from "./canary.ts";

interface WorkerConfig {
  scenario: Scenario;
  runId: string;
  model: string;
  token: string;
  mode: "live" | "offline";
  maxRequests: number;
  maxTokens: number;
  timeoutMs: number;
  canaryValue: string;
}
const config = JSON.parse(
  readFileSync("/control/config.json", "utf8"),
) as WorkerConfig;
const version = (
  JSON.parse(readFileSync("/app/cli/package.json", "utf8")) as {
    version: string;
  }
).version;
const evidence: RunEvidence = {
  scenarioId: config.scenario.id,
  runId: config.runId,
  mode: config.mode,
  status: "completed",
  output: "",
  durationMs: 0,
  modelRequests: 0,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    missingRequests: 0,
  },
  events: [],
  tools: [],
  terminal: [],
  checks: [],
};
const start = Date.now();
mkdirSync("/workspace", { recursive: true });
chownSync("/workspace", 1000, 1000);
mkdirSync("/workspace/.git", { recursive: true });
for (const [name, content] of Object.entries(config.scenario.files)) {
  const target = safeFixturePath("/workspace", name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  chownSync(target, 1000, 1000);
}
// All fixture directories are writable by tools; observation/control directories are not.
const prepareDirectory = (directory: string): void => {
  chownSync(directory, 1000, 1000);
};
for (const name of Object.keys(config.scenario.files)) {
  let directory = dirname(safeFixturePath("/workspace", name));
  while (directory.startsWith("/workspace")) {
    prepareDirectory(directory);
    if (directory === "/workspace") break;
    directory = dirname(directory);
  }
}
mkdirSync("/tmp/tool-home", { recursive: true });
chownSync("/tmp/tool-home", 1000, 1000);
mkdirSync("/canary", { recursive: true });
chmodSync("/canary", 0o755);
writeFileSync("/canary/secret.txt", config.canaryValue);
chmodSync("/canary/secret.txt", 0o644);
writeFileSync("/canary/protected.txt", "protected");
chmodSync("/canary/protected.txt", 0o666);
const stopCanaries = await watchCanaries(evidence, config.canaryValue);
mkdirSync("/observer", { recursive: true, mode: 0o700 });
chmodSync("/observer", 0o700);
writeFileSync(
  "/observer/credentials.json",
  JSON.stringify({
    version: 2,
    providers: { "kimi-coding": { type: "api_key", key: config.token } },
  }),
  { mode: 0o600 },
);
const platform = await createPiAiPlatform({
  credentials: new CredentialStore("/observer/credentials.json"),
  modelCatalogStore: new ModelCatalogStore("/observer/models.json"),
  excludedProviderIds: new Set(),
  verifiedProviderIds: new Set(),
});
const tools = createIsolatedTools(evidence, config.scenario, config.canaryValue);
let faultInjected = false;
const adapter: ModelAdapter = {
  name: platform.adapter.name,
  async runAttempt(request: ModelRequest): Promise<ModelResult> {
    if (evidence.modelRequests >= config.maxRequests) {
      evidence.status = "budget_exceeded";
      throw new ModelError("Evaluation request budget reached", {
        kind: "protocol",
      });
    }
    const total =
      evidence.usage.inputTokens +
      evidence.usage.outputTokens +
      evidence.usage.cacheReadTokens +
      evidence.usage.cacheWriteTokens;
    if (total >= config.maxTokens) {
      evidence.status = "budget_exceeded";
      throw new ModelError("Evaluation token budget reached", {
        kind: "protocol",
      });
    }
    if (!faultInjected && config.scenario.fault === "model-once") {
      faultInjected = true;
      evidence.events.push({
        kind: "eval.fault_injected",
        time: Date.now(),
        payload: { model: true },
      });
      throw new ModelError("Injected temporary server fault", {
        kind: "server",
      });
    }
    evidence.modelRequests++;
    let result: ModelResult;
    try {
      result = await platform.adapter.runAttempt(request);
    } catch (error) {
      evidence.usage.missingRequests++;
      throw error;
    }
    evidence.usage.inputTokens += result.usage.inputTokens;
    evidence.usage.outputTokens += result.usage.outputTokens;
    evidence.usage.cacheReadTokens += result.usage.cacheReadTokens ?? 0;
    evidence.usage.cacheWriteTokens += result.usage.cacheWriteTokens ?? 0;
    if (result.usage.inputTokens + result.usage.outputTokens === 0)
      evidence.usage.missingRequests++;
    return result;
  },
};
const controller = new SessionController({
  sessionsRoot: "/observer/sessions",
  projectRoot: "/workspace",
  initialCwd: "/workspace",
  appVersion: version,
  provider: "kimi-coding",
  model: config.model,
  reasoningEffort: "high",
});
await controller.createNew();
const runtime = createSessionRuntime({
  modelAdapter: adapter,
  catalog: platform.catalog,
  route: {
    provider: "kimi-coding",
    model: config.model,
    baseUrl: "http://gateway:8080",
  },
  tools,
  sessionController: controller,
  projectRoot: "/workspace",
  startupCwd: "/workspace",
  version,
});
runtime.session.eventBus.subscribe((event) => {
  if (!event.kind.includes("delta") && !event.kind.includes("snapshot"))
    evidence.events.push({
      kind: event.kind,
      time: Date.now(),
      payload: event.payload as Record<string, unknown>,
    });
});
const timer = setTimeout(() => {
  evidence.status = "timeout";
  runtime.session.requestCancel("evaluation timeout");
}, config.timeoutMs);
try {
  for (const turn of config.scenario.turns) {
    if (turn.before === "resume") {
      const id = controller.currentSessionId!;
      await controller.resume(id);
      runtime.refreshSession();
      evidence.events.push({
        kind: "eval.session_resumed",
        time: Date.now(),
        payload: {},
      });
    }
    if (turn.before === "compact") {
      const result = await runtime.compact();
      runtime.refreshSession();
      evidence.events.push({
        kind: "eval.compacted",
        time: Date.now(),
        payload: { ...result },
      });
    }
    await runtime.session.submitAction({
      id: randomUUID(),
      source: "user",
      type: "prompt",
      text: turn.prompt,
    });
    if (turn.steer) {
      await runtime.session.submitAction({
        id: randomUUID(),
        source: "user",
        type: "steer",
        text: turn.steer,
      });
      evidence.events.push({
        kind: "eval.steer_submitted",
        time: Date.now(),
        payload: {},
      });
    }
    if (!(await runtime.session.waitForIdle(config.timeoutMs))) {
      evidence.status = "timeout";
      break;
    }
    const failed = evidence.events.findLast(
      (event) => event.kind === "task.failed",
    );
    if (failed) {
      evidence.status =
        evidence.status === "completed" ? "error" : evidence.status;
      evidence.error = String(failed.payload.error ?? "Agent task failed");
      break;
    }
    const last = runtime.agent.messages.findLast(
      (message) =>
        message.role === "assistant" &&
        message.content.some((block) => block.type === "text"),
    );
    if (last?.role === "assistant")
      evidence.output +=
        last.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("") + "\n";
  }
} catch (error) {
  if (evidence.status === "completed") evidence.status = "error";
  evidence.error = error instanceof Error ? error.message : String(error);
} finally {
  clearTimeout(timer);
  await runtime.session.close({ timeoutMs: 3000 });
  await runtime.close();
  await stopCanaries();
  evidence.durationMs = Date.now() - start;
  writeFileSync("/observer/evidence.json", JSON.stringify(evidence), {
    mode: 0o600,
  });
  process.stdout.write(JSON.stringify({ status: evidence.status }) + "\n");
}
