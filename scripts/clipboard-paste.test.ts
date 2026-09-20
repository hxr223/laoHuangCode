import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import sharp from "sharp";
import { clipboardReadCommand, createClipboardPaste, createClipboardReadRunner, MAC_CLIPBOARD_SCRIPT } from "../apps/cli/src/clipboard-paste.ts";
import { TerminalUI } from "../packages/terminal/tui/src/tui/ui.ts";
import { MemoryTerminalDriver } from "../packages/terminal/tui/src/tui/screen.ts";
import { EditorState } from "../packages/terminal/tui/src/tui/editor.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("clipboard paste: platform commands use native tools and Windows STA", () => {
  assert.equal(clipboardReadCommand("darwin").command, "/usr/bin/osascript");
  const windows = clipboardReadCommand("win32");
  assert.ok(windows.args.includes("-STA"));
  assert.match(Buffer.from(windows.args.at(-1)!, "base64").toString("utf16le"), /Clipboard\]::GetImage/);
  assert.throws(() => clipboardReadCommand("linux"), /native macOS or Windows/);
});

test("clipboard paste: PNG persists at a quoted path until close, including paths with spaces", async t => {
  const root = await mkdtemp(join(tmpdir(), "clipboard paste test "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toBuffer();
  for (const platform of ["darwin", "win32"] as const) {
    const service = createClipboardPaste({ platform, env: {}, tempRoot: root, run: async () => JSON.stringify({ kind: "image", base64: data.toString("base64") }) });
    const text = await service.read(new AbortController().signal);
    const path = JSON.parse(text!.trim()) as string;
    assert.deepEqual(await readFile(path), data);
    await service.close();
    await assert.rejects(readFile(path));
  }
  assert.deepEqual(await readdir(root), []);
});

test("clipboard paste: text fallback, empty, malformed data, limits, SSH and cancellation", async () => {
  let response = JSON.stringify({ kind: "text", text: "hello\r\n世界\u001b\u0000" });
  const service = createClipboardPaste({ platform: "darwin", env: {}, run: async () => response });
  assert.equal(await service.read(new AbortController().signal), "hello\n世界");
  response = '{"kind":"empty"}';
  assert.equal(await service.read(new AbortController().signal), null);
  for (const value of ["invalid", '{"kind":"image","base64":"not image"}', JSON.stringify({ kind: "image", base64: Buffer.from("bad png").toString("base64") }), JSON.stringify({ kind: "text", text: "a".repeat(1024 * 1024 + 1) })]) {
    response = value;
    await assert.rejects(service.read(new AbortController().signal));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.read(controller.signal));
  await service.close();
  const remote = createClipboardPaste({ platform: "darwin", env: { SSH_CONNECTION: "host" }, run: async () => { throw new Error("must not run"); } });
  await assert.rejects(remote.read(new AbortController().signal), /SSH/);
});

test("clipboard runner: bounds output, times out, cancels, and does not expose stderr", async () => {
  const run = createClipboardReadRunner(process.env, 3000);
  assert.equal(await run(process.execPath, ["-e", "process.stdout.write('ok')"], new AbortController().signal), "ok");
  await assert.rejects(run(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(31*1024*1024))"], new AbortController().signal), /size limit/);
  await assert.rejects(run(process.execPath, ["-e", "process.stderr.write('private clipboard');process.exit(1)"], new AbortController().signal), error => {
    assert.doesNotMatch(String(error), /private clipboard/); return true;
  });
  await assert.rejects(createClipboardReadRunner(process.env, 50)(process.execPath, ["-e", "setInterval(()=>{},1000)"], new AbortController().signal), /timed out/);
  const controller = new AbortController();
  const pending = run(process.execPath, ["-e", "setInterval(()=>{},1000)"], controller.signal);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test("clipboard paste: native macOS PNG, TIFF conversion and text using an isolated pasteboard", { skip: process.platform !== "darwin" }, async () => {
  const run = createClipboardReadRunner(process.env);
  for (const kind of ["png", "tiff", "text", "empty"] as const) {
    const board = `laohuang-test-${randomUUID()}`;
    const source = sharp({ create: { width: 2, height: 2, channels: 3, background: "blue" } });
    const data = kind === "tiff" ? await source.tiff().toBuffer() : await source.png().toBuffer();
    const setup = kind === "text" ? "pb.setStringForType($('test 世界'), $.NSPasteboardTypeString);"
      : kind === "empty" ? "" : `pb.setDataForType($.NSData.alloc.initWithBase64EncodedStringOptions($('${data.toString("base64")}'), 0), ${kind === "png" ? "$.NSPasteboardTypePNG" : "$.NSPasteboardTypeTIFF"});`;
    const script = MAC_CLIPBOARD_SCRIPT.replace("function run()", "function readTest()").replace("var pb = $.NSPasteboard.generalPasteboard;", `var pb = $.NSPasteboard.pasteboardWithName($('${board}')); pb.clearContents; ${setup}`)
      + `\nfunction run() { try { return readTest(); } finally { $.NSPasteboard.pasteboardWithName($('${board}')).releaseGlobally; } }`;
    const value = JSON.parse(await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], new AbortController().signal));
    if (kind === "empty") assert.equal(value.kind, "empty");
    else if (kind === "text") assert.equal(value.text, "test 世界");
    else {
      assert.equal(value.kind, "image");
      assert.equal((await sharp(Buffer.from(value.base64, "base64")).metadata()).format, "png");
    }
  }
});

for (const [key, bytes] of [["ctrl+v", "\x16"], ["alt+v", "\x1bv"], ["ctrl+v", "\x1b[118;5u"], ["alt+v", "\x1b[118;3u"], ["ctrl+v", "\x1b[27;5;118~"], ["alt+v", "\x1b[27;3;118~"]]) {
  test(`clipboard TUI: ${key} (${JSON.stringify(bytes)}) inserts at cursor without submitting, duplicate presses coalesce`, async t => {
    const editor = new EditorState();
    let calls = 0;
    let finish!: (text: string) => void;
    const submissions: string[] = [];
    const ui = new TerminalUI({ driver: new MemoryTerminalDriver(), editorFactory: () => editor,
      keybindingOverrides: { paste_clipboard: [key!] }, clipboardReader: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
    t.after(() => ui.close()); ui.startLoop(text => submissions.push(text));
    ui.setComposerText("ab"); editor.cursor = 1;
    ui.feedInputBytes(Buffer.from(bytes!)); ui.drainLoop();
    ui.feedInputBytes(Buffer.from(bytes!)); ui.drainLoop();
    await tick(); assert.equal(calls, 1);
    finish(' "/tmp/my image.png" '); await tick(); ui.drainLoop();
    assert.equal(editor.text, 'a "/tmp/my image.png" b');
    assert.deepEqual(submissions, []);
    ui.feedInputBytes(Buffer.from("\r")); ui.drainLoop();
    assert.deepEqual(submissions, ['a "/tmp/my image.png" b']);
  });
}

for (const change of ["typing", "submit", "session", "modal", "close"]) {
  test(`clipboard TUI: stale result is discarded after ${change}`, async t => {
    const editor = new EditorState(); let finish!: (text: string) => void;
    const ui = new TerminalUI({ driver: new MemoryTerminalDriver(), editorFactory: () => editor,
      keybindingOverrides: { paste_clipboard: ["ctrl+v"] }, clipboardReader: async () => new Promise(resolve => { finish = resolve; }) });
    t.after(() => ui.close()); ui.startLoop(() => {});
    ui.feedInputBytes(Buffer.from("\x16")); ui.drainLoop(); await tick();
    if (change === "typing") { ui.feedInputBytes(Buffer.from("new")); ui.drainLoop(); }
    if (change === "submit") { ui.feedInputBytes(Buffer.from("\r")); ui.drainLoop(); }
    if (change === "session") ui.setSessionId("other");
    if (change === "modal") { void ui.prompt({ id: "secret", kind: "secret", message: "password" }); ui.drainLoop(); }
    if (change === "close") ui.close();
    finish("STALE"); await tick(); ui.drainLoop();
    assert.doesNotMatch(editor.text, /STALE/);
  });
}

test("clipboard TUI: modal never invokes the image reader; failures remain visible", async t => {
  const ui = new TerminalUI({ driver: new MemoryTerminalDriver(), keybindingOverrides: { paste_clipboard: ["ctrl+v"] }, clipboardReader: async () => { throw new Error("reader unavailable"); } });
  t.after(() => ui.close()); ui.startLoop(() => {});
  void ui.prompt({ id: "secret", kind: "secret", message: "password" }); ui.drainLoop();
  ui.feedInputBytes(Buffer.from("\x16")); ui.drainLoop(); await tick(); ui.drainLoop();
  assert.doesNotMatch(ui.buildHistoryLines(80).join("\n"), /reader unavailable/);
  ui.feedInputBytes(Buffer.from("\x1b")); ui.drainLoop();
  ui.feedInputBytes(Buffer.from("\x16")); ui.drainLoop(); await tick(); ui.drainLoop();
  assert.match(ui.buildHistoryLines(80).join("\n"), /reader unavailable/);
});
