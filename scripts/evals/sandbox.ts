import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IMAGE, OUTPUT_ROOT, requirePreparedImage } from "./build.ts";
import { runProcess, type ProcessResult } from "./process.ts";
import { safeFixturePath, verifyEvidence } from "./verifier.ts";
import type { RunEvidence, RunOptions, Scenario } from "./types.ts";

export function readKimiKey(): string {
  if (process.env.KIMI_API_KEY) return process.env.KIMI_API_KEY;
  const root = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const path = process.env.LAOHUANG_CONFIG
    ? join(dirname(process.env.LAOHUANG_CONFIG), "credentials.json")
    : join(root, "laohuang/credentials.json");
  try {
    const document = JSON.parse(readFileSync(path, "utf8")) as {
      providers?: Record<string, { type?: string; key?: string }>;
    };
    const credential = document.providers?.["kimi-coding"];
    if (credential?.type === "api_key" && credential.key) return credential.key;
  } catch {
    /* Never include credential content in a diagnostic. */
  }
  throw new Error(
    "Kimi Code key missing: configure kimi-coding in laohuang or set KIMI_API_KEY",
  );
}
export function redact(value: string, secrets: readonly string[]): string {
  for (const secret of secrets)
    if (secret) value = value.split(secret).join("[REDACTED]");
  return value;
}
/** Only fixture inputs are visible to the agent; checks and reference solutions stay on the host. */
export function agentScenario(scenario: Scenario): Scenario {
  const { solution: _solution, checks: _checks, ...input } = scenario;
  return { ...input, checks: [] };
}
export async function runScenario(
  scenario: Scenario,
  options: RunOptions,
): Promise<RunEvidence> {
  requirePreparedImage();
  const apiKey =
    options.mode === "live" ? readKimiKey() : "offline-placeholder";
  const token = randomBytes(24).toString("hex"),
    runId = randomUUID();
  const prefix = `lh-eval-${runId}`,
    network = prefix + "-net",
    gateway = prefix + "-gateway",
    worker = prefix + "-worker";
  const workVolume = prefix + "-work",
    observerVolume = prefix + "-observer";
  const directory = join(options.outputRoot ?? OUTPUT_ROOT, "runs", runId),
    control = join(directory, "control"),
    fixtures = join(directory, "files");
  mkdirSync(control, { recursive: true, mode: 0o755 });
  mkdirSync(fixtures, { recursive: true });
  chmodSync(directory, 0o700);
  const model = options.model ?? "kimi-for-coding";
  const timeoutMs =
    options.timeoutMs ??
    scenario.timeoutMs ??
    (scenario.turns.length > 1 ? 600_000 : 180_000);
  const maxRequests =
    options.maxRequests ?? (scenario.turns.length > 1 ? 40 : 20);
  const config = {
    scenario: agentScenario(scenario),
    runId,
    model,
    token,
    mode: options.mode,
    canaryValue: options.canaryValue ?? "EVAL_CANARY_SECRET_7429",
    maxRequests,
    maxTokens: options.maxTokens ?? 300_000,
    timeoutMs,
  };
  writeFileSync(join(control, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  let evidence: RunEvidence = {
    scenarioId: scenario.id,
    runId,
    mode: options.mode,
    status: "error",
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
    artifacts: directory,
  };
  const started = Date.now(),
    createdContainers: string[] = [],
    createdVolumes: string[] = [];
  const cancelled = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, cancelled.signal])
    : cancelled.signal;
  const cancellationPoll = setInterval(() => {
    if (options.outputRoot && existsSync(join(options.outputRoot, "cancelled")))
      cancelled.abort();
  }, 500);
  let createdNetwork = false,
    gatewayProcess: Promise<ProcessResult> | undefined;
  async function docker(
    args: string[],
    extra: {
      timeoutMs?: number;
      input?: string;
      signal?: AbortSignal;
      maxBytes?: number;
    } = {},
  ): Promise<ProcessResult> {
    const result = await runProcess("docker", args, {
      timeoutMs: extra.timeoutMs ?? 15000,
      ...extra,
    });
    if (result.code !== 0)
      throw new Error(
        redact(`Docker ${args[0]} failed: ${result.stderr || result.stdout}`, [
          apiKey,
          token,
        ]),
      );
    return result;
  }
  const limits = [
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit=128",
    "--memory=768m",
    "--cpus=1",
    "--tmpfs=/tmp:rw,nosuid,nodev,size=128m",
  ];
  try {
    if (options.signal?.aborted)
      throw new Error("Evaluation cancelled before starting");
    await docker(["network", "create", "--internal", network]);
    createdNetwork = true;
    for (const volume of [workVolume, observerVolume]) {
      await docker(["volume", "create", volume]);
      createdVolumes.push(volume);
    }
    await docker([
      "create",
      "--name",
      gateway,
      "--network",
      network,
      "--network-alias",
      "gateway",
      ...limits,
      "--user=1000:1000",
      "-i",
      IMAGE,
      "node",
      "/app/gateway-main.mjs",
    ]);
    createdContainers.push(gateway);
    // Only the credential gateway can reach the provider. Tools have no external route.
    await docker(["network", "connect", "bridge", gateway]);
    gatewayProcess = runProcess("docker", ["start", "-ai", gateway], {
      input:
        JSON.stringify({
          apiKey,
          token,
          model,
          maxRequests,
          offline: options.mode === "offline",
        }) + "\n",
      timeoutMs: timeoutMs + 120000,
    });
    for (let i = 0; ; i++) {
      const logs = await docker(["logs", gateway]);
      if (logs.stdout.includes('"kind":"ready"')) break;
      if (i >= 50) throw new Error("Credential gateway did not become ready");
      await delay(100);
    }
    if (signal.aborted) throw new Error("Evaluation cancelled during setup");
    await docker([
      "create",
      "--name",
      worker,
      "--network",
      network,
      ...limits,
      "--cap-add=SETUID",
      "--cap-add=SETGID",
      "--cap-add=CHOWN",
      "--cap-add=DAC_OVERRIDE",
      "--cap-add=FOWNER",
      "--tmpfs=/canary:rw,nosuid,nodev,size=1m",
      "--mount",
      `type=volume,src=${workVolume},dst=/workspace`,
      "--mount",
      `type=volume,src=${observerVolume},dst=/observer`,
      "--mount",
      `type=bind,src=${control},dst=/control,readonly`,
      IMAGE,
      "node",
      "/app/worker.mjs",
    ]);
    createdContainers.push(worker);
    const execution = await runProcess("docker", ["start", "-a", worker], {
      timeoutMs: timeoutMs + 15000,
      signal,
    });
    if (execution.timedOut || execution.cancelled)
      await docker(["kill", worker]).catch(() => {});
    await docker([
      "cp",
      `${worker}:/observer/evidence.json`,
      join(directory, "evidence.raw.json"),
    ]).catch(() => {});
    try {
      evidence = JSON.parse(
        readFileSync(join(directory, "evidence.raw.json"), "utf8"),
      ) as RunEvidence;
    } catch {
      evidence.error = redact(
        execution.stderr ||
          execution.stdout ||
          "Worker exited without evidence",
        [apiKey, token],
      );
    }
    if (execution.timedOut) evidence.status = "timeout";
    if (execution.cancelled) evidence.status = "cancelled";
    const snapshotContainer = prefix + "-snapshot";
    createdContainers.push(snapshotContainer);
    const snapshot = await docker(
      [
        "run",
        "--name",
        snapshotContainer,
        "--network=none",
        ...limits,
        "--user=1000:1000",
        "--mount",
        `type=volume,src=${workVolume},dst=/workspace,readonly`,
        IMAGE,
        "node",
        "/app/snapshot.mjs",
      ],
      { maxBytes: 16 * 1024 * 1024 },
    );
    const captured = JSON.parse(snapshot.stdout) as {
      files: Record<string, string>;
      rejected: string[];
    };
    for (const [name, content] of Object.entries(captured.files)) {
      const path = safeFixturePath(fixtures, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(content, "base64"));
    }
    const checks = await verifyEvidence(
      scenario,
      evidence,
      fixtures,
      async (check) => {
        const checkName = `check-${randomUUID()}.json`;
        const completionToken = randomBytes(32).toString("hex");
        const verifierContainer =
          prefix + "-verify-" + randomBytes(4).toString("hex");
        createdContainers.push(verifierContainer);
        writeFileSync(join(control, checkName), JSON.stringify(check), {
          mode: 0o644,
        });
        const result = await runProcess(
          "docker",
          [
            "run",
            "--name",
            verifierContainer,
            "-i",
            "--network=none",
            ...limits,
            "--user=1000:1000",
            "--mount",
            `type=volume,src=${workVolume},dst=/workspace,readonly`,
            "--mount",
            `type=bind,src=${control},dst=/control,readonly`,
            IMAGE,
            "node",
            "/app/module-verifier.mjs",
            `/control/${checkName}`,
          ],
          { input: completionToken, timeoutMs: 15000, signal },
        );
        return result.code === 0 &&
          result.stdout.includes(`verified:${completionToken}`)
          ? null
          : result.timedOut
            ? "Verification timed out"
            : result.stderr.slice(-3000) ||
              "Module verification did not complete";
      },
    );
    evidence.checks = [
      ...checks,
      ...evidence.checks.filter((check) => check.name === "canary-boundary"),
      {
        name: "artifact-integrity",
        pass: captured.rejected.length === 0,
        reason: captured.rejected.length
          ? `Unsupported artifact paths: ${captured.rejected.join(", ")}`
          : "Regular fixture files captured",
      },
    ];
  } catch (error) {
    evidence.status = signal.aborted ? "cancelled" : "error";
    evidence.error = redact(
      error instanceof Error ? error.message : String(error),
      [apiKey, token],
    );
  } finally {
    clearInterval(cancellationPoll);
    for (const container of createdContainers.reverse())
      await runProcess("docker", ["rm", "-f", container], { timeoutMs: 10000 });
    if (gatewayProcess) {
      const logs = await gatewayProcess;
      const records = logs.stdout.split("\n").flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
      const requests = records.filter(
        (record) => record.kind === "request",
      ).length;
      if (scenario.tui) {
        evidence.usage.missingRequests += Math.max(
          0,
          requests - evidence.modelRequests,
        );
        evidence.modelRequests = requests;
      }
      writeFileSync(
        join(directory, "gateway.json"),
        redact(JSON.stringify(records, null, 2), [apiKey, token]),
      );
    }
    for (const volume of createdVolumes)
      await runProcess("docker", ["volume", "rm", volume], {
        timeoutMs: 10000,
      });
    if (createdNetwork)
      await runProcess("docker", ["network", "rm", network], {
        timeoutMs: 10000,
      });
    evidence.durationMs = Date.now() - started;
    evidence.artifacts = directory;
    evidence = JSON.parse(
      redact(JSON.stringify(evidence), [apiKey, token]),
    ) as RunEvidence;
    writeFileSync(
      join(directory, "evidence.json"),
      JSON.stringify(evidence, null, 2),
      { mode: 0o600 },
    );
    // Rewrite transient observer copy and scoped config so artifacts never retain tokens.
    writeFileSync(
      join(directory, "evidence.raw.json"),
      JSON.stringify(evidence),
      { mode: 0o600 },
    );
    writeFileSync(
      join(control, "config.json"),
      redact(JSON.stringify(config), [token]),
      { mode: 0o600 },
    );
  }
  return evidence;
}
