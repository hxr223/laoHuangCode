import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  StdTerminalDriver,
  TerminalUI,
  type LoopInputSource,
} from "../packages/terminal/tui/src/tui/ui.ts";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const OFFLINE_SECRET = "offline-secret-value";
const DEFAULT_TIMEOUT_MS = 5_000;

function event(
  kind: string,
  correlationId: string,
  payload: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind, correlation_id: correlationId, payload };
}

async function runHarness(): Promise<void> {
  const driver = new StdTerminalDriver();
  const ui = new TerminalUI({
    driver,
    theme: "dark",
    provider: "offline",
    model: "fake-local",
    effort: "off",
  });
  const loop = ui.interactiveLoop;
  assert.ok(loop !== null);

  function publishFirstTurn(): void {
    ui.publishEvent(event("task.started", "task-1"));
    ui.publishEvent(event("model.reasoning_delta", "r1", {
      text: "offline reasoning frozen once",
    }));
    ui.publishEvent(event("model.text_delta", "r1", {
      text: "offline ordinary answer",
    }));
    ui.publishEvent(event("model.reasoning_delta", "r1", {
      text: " late reasoning must not render",
    }));
    ui.publishEvent(event("tool.started", "tool-1", {
      name: "bash",
      arguments: {
        command: "printf local",
        token: OFFLINE_SECRET,
      },
    }));
    ui.publishEvent(event("tool.output_delta", "tool-1", {
      stream: "stdout",
      text: "local tool output",
    }));
    ui.publishEvent(event("tool.finished", "tool-1", {
      status: "completed",
      exit_code: 0,
      duration_ms: 4,
    }));
    ui.publishEvent(event("model.response_committed", "r1"));
    ui.publishEvent(event("task.completed", "task-1"));
  }

  function publishSecondTurn(): void {
    ui.publishEvent(event("task.started", "task-2"));
    ui.publishEvent(event("model.text_delta", "r2", {
      text: "offline second answer",
    }));
    ui.publishEvent(event("model.response_committed", "r2"));
    ui.publishEvent(event("task.completed", "task-2"));
    setTimeout(() => {
      ui.showGoodbye();
      ui.close();
      process.exit(0);
    }, 1_000);
  }

  function handleSubmit(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "/exit") {
      ui.showGoodbye();
      ui.requestExit();
    } else if (trimmed.includes("first")) {
      publishFirstTurn();
    } else if (trimmed.includes("second")) {
      publishSecondTurn();
    } else {
      ui.showAssistant(`offline echo: ${text}`);
    }
  }

  ui.showWelcome();
  loop.start(handleSubmit);
  await loop.run(driver.inputStream as unknown as LoopInputSource);
  if (ui.renderError !== null) {
    throw ui.renderError instanceof Error
      ? ui.renderError
      : new Error(String(ui.renderError));
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function runTmux(args: readonly string[]): string {
  const result = spawnSync("tmux", [...args], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  assert.equal(
    result.status,
    0,
    [
      `tmux ${args.join(" ")} failed`,
      result.stdout.trim(),
      result.stderr.trim(),
    ].filter(Boolean).join("\n"),
  );
  return result.stdout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function capture(session: string, options: { styles?: boolean } = {}): string {
  const args = [
    "capture-pane",
    "-t",
    session,
    "-p",
    "-S",
    "-200",
  ];
  if (options.styles === true) {
    args.push("-e");
  }
  return runTmux(args);
}

async function waitForCapture(
  session: string,
  label: string,
  predicate: (value: string) => boolean,
): Promise<string> {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  let last = "";
  while (Date.now() < deadline) {
    last = capture(session);
    if (predicate(last)) {
      return last;
    }
    await sleep(100);
  }
  throw new Error(`offline transcript smoke (${label}) timed out\n${last}`);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;:]*[ -/]*[@-~]/gu, "");
}

function countNeedles(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function validatePlainCapture(label: string, value: string): void {
  const plain = stripAnsi(value);
  assert.equal(/[╭╮╰╯│]/u.test(plain), true, `${label}: framed tui surface missing`);
  assert.equal(
    /^[ \t]+[0-9]+[.)][ \t]/mu.test(plain),
    false,
    `${label}: numbered interactive list detected`,
  );
  assert.equal(
    /\[\?[0-9;]*[A-Za-z]|\[>[0-9;]+[A-Za-z]|_pi:/u.test(plain),
    false,
    `${label}: terminal negotiation fragment detected`,
  );
  assert.ok(countNeedles(plain, "│> ") <= 1, `${label}: duplicated prompt detected`);
  assert.equal(plain.includes(OFFLINE_SECRET), false, `${label}: secret leaked`);
}

function assertDefaultForegroundAnswer(styledCapture: string): void {
  const line = styledCapture
    .split(/\r?\n/u)
    .find((value) => value.includes("offline ordinary answer"));
  assert.ok(line, "styled capture did not include the ordinary answer");
  const beforeAnswer = line.slice(0, line.indexOf("offline ordinary answer"));
  const contentPrefix = beforeAnswer.slice(beforeAnswer.lastIndexOf("│") + 1);
  assert.equal(
    /\x1b\[(?:3[0-7]|9[0-7]|38[;:])/u.test(contentPrefix),
    false,
    "ordinary answer used an explicit foreground style",
  );
}

async function waitForStatusFile(path: string): Promise<string> {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const value = readFileSync(path, "utf8");
      if (value.length > 0) {
        return value.trim();
      }
    }
    await sleep(100);
  }
  throw new Error("offline transcript harness did not exit");
}

async function runVerifier(): Promise<void> {
  const tmuxVersion = spawnSync("tmux", ["-V"], { encoding: "utf8" });
  if (tmuxVersion.status !== 0) {
    throw new Error("tmux is required for offline transcript terminal smoke");
  }

  const tempDir = mkdtempSync(join(tmpdir(), "laohuang-offline-terminal-"));
  const statusFile = join(tempDir, "status");
  const session = `laohuang-offline-transcript-${process.pid}`;
  const command = [
    `${shellQuote(process.execPath)} ${shellQuote(SCRIPT_PATH)} --harness`,
    `exit_status=$?`,
    `printf '%s' "$exit_status" > ${shellQuote(statusFile)}`,
    "sleep 2",
  ].join("; ");

  try {
    runTmux([
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "80",
      "-y",
      "12",
      command,
    ]);

    await waitForCapture(session, "startup", (value) =>
      value.includes("Welcome to LaoHuang Code!")
    );
    runTmux(["send-keys", "-t", session, "first offline prompt", "Enter"]);
    const collapsed = await waitForCapture(session, "collapsed first turn", (value) =>
      value.includes("first offline prompt") &&
      value.includes("offline ordinary answer") &&
      value.includes("● bash") &&
      !value.includes("local tool output")
    );
    validatePlainCapture("collapsed first turn", collapsed);
    assert.ok(collapsed.includes("thinking  offline reasoning frozen once"));
    assert.equal(collapsed.includes("late reasoning must not render"), false);
    assertDefaultForegroundAnswer(capture(session, { styles: true }));

    runTmux(["send-keys", "-t", session, "C-o"]);
    const expanded = await waitForCapture(session, "expanded tool output", (value) =>
      value.includes("local tool output")
    );
    validatePlainCapture("expanded tool output", expanded);

    runTmux(["send-keys", "-t", session, "C-o"]);
    const recollapsed = await waitForCapture(session, "recollapsed tool output", (value) =>
      value.includes("offline ordinary answer") &&
      !value.includes("local tool output")
    );
    validatePlainCapture("recollapsed tool output", recollapsed);

    runTmux(["resize-window", "-t", session, "-x", "52", "-y", "8"]);
    runTmux(["send-keys", "-t", session, "second offline prompt", "Enter"]);
    const second = await waitForCapture(session, "second turn after resize", (value) =>
      value.includes("offline ordinary answer") &&
      value.includes("second offline prompt") &&
      value.includes("offline second answer")
    );
    validatePlainCapture("second turn after resize", second);
    assert.equal(second.includes("late reasoning must not render"), false);

    const historySize = Number.parseInt(
      runTmux(["display-message", "-p", "-t", session, "#{history_size}"]).trim(),
      10,
    );
    assert.ok(historySize > 0, "second turn did not create native tmux scrollback");

    assert.equal(await waitForStatusFile(statusFile), "0");

    console.log("offline transcript terminal smoke passed");
  } finally {
    spawnSync("tmux", ["kill-session", "-t", session], { encoding: "utf8" });
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv.includes("--harness")) {
  await runHarness();
} else {
  await runVerifier();
}
