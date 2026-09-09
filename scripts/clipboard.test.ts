import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  copyText,
  createClipboardRunner,
  type ClipboardOptions,
} from "../apps/cli/src/clipboard.ts";

function fixture(overrides: Partial<ClipboardOptions> = {}) {
  const calls: { command: string; args: readonly string[]; text: string }[] = [];
  const sequences: string[] = [];
  const options: ClipboardOptions = {
    platform: "darwin", environ: { TERM: "xterm-256color" }, isTTY: true,
    writeTerminal: (sequence) => { sequences.push(sequence); },
    run: async (command, args, text) => { calls.push({ command, args, text }); return { code: 0, stderr: "" }; },
    ...overrides,
  };
  return { options, calls, sequences };
}

test("native clipboard receives exact Markdown through stdin, never command arguments", async () => {
  const f = fixture();
  const text = "## 中文\n`echo $HOME`\n\"quoted\" 'text'\n";
  assert.deepEqual(await copyText(text, f.options), { status: "copied" });
  assert.deepEqual(f.calls, [{ command: "pbcopy", args: [], text }]);
  assert.deepEqual(f.sequences, []);
});

test("Linux selects available Wayland and X11 clipboard backends", async () => {
  const wayland = fixture({ platform: "linux", environ: { WAYLAND_DISPLAY: "wayland-0" } });
  assert.equal((await copyText("text", wayland.options)).status, "copied");
  assert.equal(wayland.calls[0]?.command, "wl-copy");
  const x11 = fixture({ platform: "linux", environ: { DISPLAY: ":0" } });
  assert.equal((await copyText("text", x11.options)).status, "copied");
  assert.deepEqual(x11.calls[0]?.args, ["-selection", "clipboard"]);
  assert.equal(x11.calls[0]?.command, "xclip");
});

test("Linux tries each applicable native backend in order", async () => {
  const f = fixture({
    platform: "linux",
    environ: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" },
    run: async (command, args, text) => {
      f.calls.push({ command, args, text });
      return { code: command === "xsel" ? 0 : 1, stderr: "unavailable" };
    },
  });
  assert.deepEqual(await copyText("text", f.options), { status: "copied" });
  assert.deepEqual(f.calls.map(({ command, args }) => ({ command, args })), [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ]);
});

test("Windows uses a fixed script, with Unicode and newlines only on stdin", async () => {
  const f = fixture({ platform: "win32" });
  const text = "中文\n'; Write-Output injected; #\n";
  assert.equal((await copyText(text, f.options)).status, "copied");
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.command, /powershell/i);
  assert.match(f.calls[0]!.args.join(" "), /Set-Clipboard/);
  assert.match(f.calls[0]!.args.join(" "), /ReadToEnd/);
  assert.ok(!f.calls[0]!.args.some((arg) => arg.includes(text)));
  assert.equal(f.calls[0]!.text, text);
});

test("SSH sends OSC52 to the user terminal without touching remote desktop clipboard", async () => {
  const f = fixture({ environ: { SSH_CONNECTION: "fixture", TERM: "xterm-256color" } });
  const text = "hello\n中文";
  assert.deepEqual(await copyText(text, f.options), { status: "sent-to-terminal" });
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.sequences, [`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`]);
});

test("tmux wraps and escapes OSC52 in one terminal write", async () => {
  const f = fixture({ environ: { SSH_TTY: "/dev/pts/1", TERM: "screen-256color", TMUX: "fixture" } });
  assert.equal((await copyText("text", f.options)).status, "sent-to-terminal");
  assert.deepEqual(f.sequences, [`\x1bPtmux;\x1b\x1b]52;c;${Buffer.from("text").toString("base64")}\x07\x1b\\`]);
});

test("native failures can fall back to OSC52 without claiming confirmed clipboard success", async () => {
  for (const run of [
    async () => ({ code: 1, stderr: "clipboard unavailable" }),
    async () => { throw Object.assign(new Error("missing executable"), { code: "ENOENT" }); },
  ]) {
    const f = fixture({ run });
    assert.equal((await copyText("text", f.options)).status, "sent-to-terminal");
    assert.equal(f.sequences.length, 1);
  }
});

test("unusable terminal paths never emit control sequences or truncate large text", async () => {
  for (const override of [
    { isTTY: false, environ: { SSH_TTY: "fixture", TERM: "xterm" } },
    { environ: { SSH_TTY: "fixture", TERM: "dumb" } },
    { environ: { SSH_TTY: "fixture", TERM: "screen", STY: "fixture" } },
  ]) {
    const f = fixture(override);
    const result = await copyText("text", f.options);
    assert.equal(result.status, "unavailable");
    assert.deepEqual(f.sequences, []);
  }
  const remote = fixture({ environ: { SSH_TTY: "fixture", TERM: "xterm" } });
  const text = "中".repeat(35_000);
  assert.equal((await copyText(text, remote.options)).status, "unavailable");
  assert.deepEqual(remote.sequences, []);
  const local = fixture();
  assert.equal((await copyText(text, local.options)).status, "copied");
  assert.equal(local.calls[0]?.text, text);
});

test("unavailable results explain terminal and size constraints", async () => {
  const noTty = fixture({ isTTY: false, run: async () => ({ code: 1, stderr: "failure" }) });
  const noTtyResult = await copyText("text", noTty.options);
  assert.equal(noTtyResult.status, "unavailable");
  assert.match(noTtyResult.reason, /TTY/i);

  const screen = fixture({ environ: { SSH_TTY: "fixture", TERM: "screen", STY: "fixture" } });
  const screenResult = await copyText("text", screen.options);
  assert.equal(screenResult.status, "unavailable");
  assert.match(screenResult.reason, /screen/i);

  const oversized = fixture({ environ: { SSH_TTY: "fixture", TERM: "xterm" } });
  const oversizedResult = await copyText("中".repeat(35_000), oversized.options);
  assert.equal(oversizedResult.status, "unavailable");
  assert.match(oversizedResult.reason, /100 KiB/i);
});

async function temporaryCommand(t: test.TestContext, source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "laohuang-clipboard-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "fake-clipboard.mjs");
  await writeFile(script, source);
  return script;
}

test("process runner passes exact UTF-8 stdin and the supplied environment without a shell", async t => {
  const script = await temporaryCommand(t, `
    process.stdin.setEncoding("utf8");
    let text = "";
    process.stdin.on("data", chunk => { text += chunk; });
    process.stdin.on("end", () => {
      process.stderr.write(JSON.stringify({ argv: process.argv.slice(2), text, fixture: process.env.CLIPBOARD_FIXTURE }));
    });
  `);
  const text = "## 中文\n`echo $HOME`\n\"quoted\" 'text'\n";
  const runner = createClipboardRunner({ CLIPBOARD_FIXTURE: "provided" });
  const result = await runner(process.execPath, [script, "a b", "$(never)", "'quoted'"], text);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stderr), {
    argv: ["a b", "$(never)", "'quoted'"],
    text,
    fixture: "provided",
  });
});

test("process runner reports nonzero exits and missing executables as failures", async t => {
  const script = await temporaryCommand(t, `process.stderr.write("fixture failure"); process.exit(7);`);
  const runner = createClipboardRunner(process.env);
  assert.deepEqual(await runner(process.execPath, [script], "text"), { code: 7, stderr: "fixture failure" });

  const missing = await runner(join(tmpdir(), "laohuang-missing-clipboard-command"), [], "text");
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /ENOENT|not found/i);
});

test("process runner times out and handles a child closing stdin without hanging", async t => {
  const hanging = await temporaryCommand(t, "setInterval(() => {}, 1000);");
  const shortRunner = createClipboardRunner(process.env, 30);
  const timedOut = await shortRunner(process.execPath, [hanging], "text");
  assert.notEqual(timedOut.code, 0);
  assert.match(timedOut.stderr, /timed out/i);

  const closedStdin = await temporaryCommand(t, `import { closeSync } from "node:fs"; closeSync(0); setTimeout(() => {}, 1000);`);
  const brokenPipe = await createClipboardRunner(process.env, 1000)(
    process.execPath,
    [closedStdin],
    "x".repeat(5 * 1024 * 1024),
  );
  assert.notEqual(brokenPipe.code, 0);
  assert.match(brokenPipe.stderr, /stdin|EPIPE|broken pipe/i);
});

test("copyText preserves real runner ENOENT and timeout causes when OSC 52 is unavailable", async t => {
  const emptyPath = await mkdtemp(join(tmpdir(), "laohuang-clipboard-empty-path-"));
  t.after(() => rm(emptyPath, { recursive: true, force: true }));
  const missingRunner = createClipboardRunner(process.env, 100);
  const missing = fixture({
    isTTY: false,
    run: (_command, args, text) => missingRunner(join(emptyPath, "missing-command"), args, text),
  });
  const missingResult = await copyText("text", missing.options);
  assert.equal(missingResult.status, "unavailable");
  assert.match(missingResult.reason, /ENOENT|not found/i);
  assert.match(missingResult.reason, /TTY/i);

  const hanging = await temporaryCommand(t, `setInterval(() => {}, 1000);`);
  const shortRunner = createClipboardRunner(process.env, 30);
  const timedOut = fixture({
    isTTY: false,
    run: (_command, args, text) => shortRunner(process.execPath, [hanging, ...args], text),
  });
  const timeoutResult = await copyText("text", timedOut.options);
  assert.equal(timeoutResult.status, "unavailable");
  assert.match(timeoutResult.reason, /timed out/i);
  assert.match(timeoutResult.reason, /TTY/i);
});

test("runner caps noisy stderr and copyText sanitizes its bounded diagnostic", async t => {
  const noisy = await temporaryCommand(t, `
    process.stderr.write("\\x1b[31mbackend exploded\\x1b[0m\\n" + "x".repeat(100_000));
    process.exit(9);
  `);
  const runner = createClipboardRunner(process.env);
  const captured = await runner(process.execPath, [noisy], "text");
  assert.equal(captured.code, 9);
  assert.equal(captured.stderr.length, 65_536);

  const f = fixture({
    isTTY: false,
    run: (_command, args, text) => runner(process.execPath, [noisy, ...args], text),
  });
  const result = await copyText("text", f.options);
  assert.equal(result.status, "unavailable");
  assert.match(result.reason, /backend exploded/);
  assert.doesNotMatch(result.reason, /[\x00-\x1f\x7f-\x9f]/);
  assert.ok(result.reason.length <= 800);
});
