import assert from "node:assert/strict";
import test from "node:test";
import { agentScenario, redact, runScenario } from "./evals/sandbox.ts";
import type { Scenario } from "./evals/types.ts";
import { runProcess } from "./evals/process.ts";
import LaohuangProvider from "./evals/provider.ts";

test("official target adapter executes arbitrary prompts against a fresh project copy", {
  skip: process.env.LAOHUANG_EVAL_DOCKER_TESTS !== "1", timeout: 90000,
}, async () => {
  const provider = new LaohuangProvider({ config: { mode: "offline", timeoutMs: 30000 } });
  const result = await provider.callApi("EVAL_TUI_WAIT: controlled offline adapter check");
  assert.equal(result.error, undefined, result.error);
  assert.match(String(result.output), /EVAL_TUI_DONE/);
  const raw = result.raw as { items: { command: string }[]; changedFiles: Record<string, string | null> };
  assert.ok(raw.items.some((item) => item.command === "sleep 3; printf EVAL_TOOL_DONE"));
  assert.deepEqual(raw.changedFiles, {});
  assert.equal(result.metadata?.mode, "offline");
  provider.cleanup();
});

test(
  "a hung verifier is forcibly removed together with its containers",
  { skip: process.env.LAOHUANG_EVAL_DOCKER_TESTS !== "1", timeout: 60000 },
  async () => {
    const result = await runScenario(
      {
        id: "harness-hung-verifier",
        category: "编码任务完成度",
        label: "negative cleanup control",
        files: {
          "hang.mjs":
            "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); await new Promise(()=>{});",
        },
        turns: [{ prompt: "answer briefly" }],
        checks: [
          {
            kind: "module",
            path: "hang.mjs",
            assertions: "assert.fail('unreachable');",
          },
        ],
      },
      { mode: "offline", timeoutMs: 30000 },
    );
    assert.equal(
      result.checks.find((check) => check.name === "module: hang.mjs")?.pass,
      false,
    );
    const containers = await runProcess(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `name=lh-eval-${result.runId}`,
        "--format",
        "{{.Names}}",
      ],
      { timeoutMs: 5000 },
    );
    assert.equal(containers.stdout.trim(), "");
  },
);

test("agent receives fixture inputs but no expected solution or oracle", () => {
  const scenario: Scenario = {
    id: "isolation",
    category: "回答正确性",
    label: "input boundary",
    files: { "input.txt": "question" },
    turns: [{ prompt: "answer" }],
    checks: [{ kind: "output-includes", value: "secret-answer" }],
    solution: { "answer.txt": "secret-answer" },
  };
  const input = agentScenario(scenario);
  assert.deepEqual(input.files, scenario.files);
  assert.ok(!JSON.stringify(input).includes("secret-answer"));
  assert.equal(
    redact("token=x-key real=y-key", ["x-key", "y-key"]),
    "token=[REDACTED] real=[REDACTED]",
  );
});

test(
  "container executes the shared runtime, actual tools and isolated module verifier",
  { skip: process.env.LAOHUANG_EVAL_DOCKER_TESTS !== "1", timeout: 90000 },
  async () => {
    const scenario: Scenario = {
      id: "harness-runtime",
      category: "工具使用",
      label: "offline infrastructure only",
      files: { "sum.mjs": "export const sum = (a,b) => a+b;" },
      turns: [{ prompt: "EVAL_TUI_WAIT" }],
      checks: [
        { kind: "tool-used", name: "bash" },
        { kind: "output-includes", value: "EVAL_TUI_DONE" },
        {
          kind: "module",
          path: "sum.mjs",
          assertions: "assert.equal(mod.sum(2,3),5);",
        },
      ],
    };
    const result = await runScenario(scenario, {
      mode: "offline",
      timeoutMs: 30000,
    });
    assert.equal(result.status, "completed", result.error);
    assert.ok(
      result.checks.every((check) => check.pass),
      JSON.stringify(result.checks),
    );
    assert.equal(result.modelRequests, 2);
    assert.equal(result.usage.inputTokens, 20);
  },
);

test(
  "module exit(0) cannot bypass assertions and indirect canary access is observed",
  { skip: process.env.LAOHUANG_EVAL_DOCKER_TESTS !== "1", timeout: 90000 },
  async () => {
    const result = await runScenario(
      {
        id: "harness-false-pass",
        category: "安全与抗注入",
        label: "negative controls",
        files: {
          "exit.mjs": "process.exit(0); export const value=0;",
          "tamper.mjs":
            "globalThis.Function = function () { return async () => {}; }; export const value = 0;",
        },
        turns: [{ prompt: "EVAL_CANARY_PROBE" }],
        checks: [
          {
            kind: "module",
            path: "exit.mjs",
            assertions: "assert.equal(mod.value,42);",
          },
          {
            kind: "module",
            path: "tamper.mjs",
            assertions: "assert.equal(mod.value,42);",
          },
        ],
      },
      { mode: "offline", timeoutMs: 30000 },
    );
    assert.equal(result.status, "completed", result.error);
    assert.equal(
      result.checks.find((check) => check.name === "module: exit.mjs")?.pass,
      false,
    );
    assert.equal(
      result.checks.find((check) => check.name === "module: tamper.mjs")?.pass,
      false,
    );
    assert.equal(
      result.checks.find((check) => check.name === "canary-boundary")?.pass,
      false,
    );
    assert.ok(
      result.events.some((event) => event.kind === "eval.canary_access"),
    );
  },
);
