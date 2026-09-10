import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { StdinPrompts } from "../apps/cli/src/stdin-prompts.ts";
import { PromptCancelledError, PromptEofError } from "@laohuang/tui";
import { MemoryTerminalDriver } from "../packages/terminal/tui/src/tui/screen.ts";
import { TerminalUI } from "../packages/terminal/tui/src/tui/ui.ts";

function terminal(wasRaw = false) {
  const changes: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: wasRaw,
    setRawMode(raw: boolean) { this.isRaw = raw; changes.push(raw); },
  });
  const output = new PassThrough();
  let transcript = "";
  output.on("data", (chunk: Buffer) => { transcript += chunk.toString(); });
  return { input, output, changes, prompts: new StdinPrompts(input), transcript: () => transcript };
}

test("secret input decodes split UTF-8, supports backspace, and restores the original raw mode", async () => {
  for (const wasRaw of [false, true]) {
    const { input, output, prompts, changes, transcript } = terminal(wasRaw);
    const answer = prompts.prompt("Key: ", output, true);
    const bytes = Buffer.from("\u4f60\u597d");
    input.write(bytes.subarray(0, 2));
    await delay(5);
    input.write(bytes.subarray(2));
    input.write("\x7f-key\r");
    assert.equal(await answer, "\u4f60-key");
    assert.equal(transcript(), "Key: \n");
    assert.deepEqual(changes, [true, wasRaw]);
    assert.equal(input.isPaused(), true);
    assert.equal(input.listenerCount("data"), 0);
  }
});

test("CRLF split across prompts is consumed once and trailing pipe data survives", async () => {
  const input = new PassThrough();
  const prompts = new StdinPrompts(input);
  const output = new PassThrough();
  const first = prompts.prompt("", output);
  input.write("13\r");
  assert.equal(await first, "13");
  input.end("\noffline-key\r\n2");
  assert.equal(await prompts.prompt("", output, true), "offline-key");
  assert.equal(await prompts.prompt("", output), "2");
  await assert.rejects(prompts.prompt("", output), PromptEofError);
});

test("cancel and EOF release stdin so another prompt can run", async () => {
  for (const [control, error] of [["\x03", PromptCancelledError], ["\x04", PromptEofError]] as const) {
    const { input, output, prompts } = terminal();
    const before = process.listenerCount("SIGINT");
    const cancelled = assert.rejects(prompts.prompt("", output, true), error);
    input.write(`partial${control}`);
    await cancelled;
    assert.equal(input.isRaw, false);
    assert.equal(process.listenerCount("SIGINT"), before);
    const next = prompts.prompt("", output, true);
    input.write("replacement\n");
    assert.equal(await next, "replacement");
  }
});

test("ordinary TTY prompts handle SIGINT without leaving an input listener", async () => {
  const { input, output, prompts } = terminal();
  const cancelled = assert.rejects(prompts.prompt("", output), PromptCancelledError);
  process.emit("SIGINT");
  await cancelled;
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
});

test("stream errors, close, and terminal setup failures restore ownership", async () => {
  for (const event of ["error", "close", "end"] as const) {
    const { input, output, prompts } = terminal();
    const failure = new Error("read failed");
    const rejected = assert.rejects(prompts.prompt("", output, true), event === "error" ? failure : PromptEofError);
    if (event === "error") input.destroy(failure);
    else if (event === "close") input.destroy();
    else input.end();
    await rejected;
    assert.equal(input.isRaw, false);
    assert.equal(input.listenerCount("data"), 0);
    assert.equal(input.listenerCount("error"), 0);
  }
  const { input, output, prompts } = terminal();
  input.setRawMode = (raw: boolean) => {
    input.isRaw = raw;
    if (raw) throw new Error("raw mode failed");
  };
  await assert.rejects(prompts.prompt("", output, true), /raw mode failed/);
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount("data"), 0);
  const next = prompts.prompt("", output);
  input.write("next\n");
  assert.equal(await next, "next");
});

test("overlapping prompts and external input readers cannot steal stdin", async () => {
  const { input, output, prompts } = terminal();
  const first = prompts.prompt("", output);
  await assert.rejects(prompts.prompt("", output, true), /already in use/);
  assert.equal(input.isRaw, false);
  input.write("first\n");
  assert.equal(await first, "first");
  const externalReader = () => {};
  input.on("data", externalReader);
  await assert.rejects(prompts.prompt("", output), /already in use/);
  assert.equal(input.listenerCount("data"), 1);
  input.removeListener("data", externalReader);
});

test("the TUI takes over paused stdin and consumes typeahead from startup", async () => {
  const { input, output, prompts } = terminal();
  const selection = prompts.prompt("", output);
  input.write("13\n/exit\r");
  assert.equal(await selection, "13");
  assert.equal(input.isPaused(), true);
  const ui = new TerminalUI({ driver: new MemoryTerminalDriver() });
  const loop = ui.interactiveLoop!;
  const submissions: string[] = [];
  loop.start((text) => { submissions.push(text); loop.requestExit(); });
  const running = loop.run(input);
  const timeout = setTimeout(() => loop.requestExit(), 500);
  try {
    await running;
    assert.deepEqual(submissions, ["/exit"]);
    assert.equal(ui.renderError, null);
    assert.equal(input.listenerCount("data"), 0);
  } finally {
    clearTimeout(timeout);
    ui.close();
  }
});
