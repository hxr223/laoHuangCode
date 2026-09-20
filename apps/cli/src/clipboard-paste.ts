import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { DEFAULT_IMAGE_LIMITS } from "@laohuang/attachment";

const MAX_OUTPUT = 30 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;

// Fixed scripts: no clipboard content or user paths are interpolated as code.
export const MAC_CLIPBOARD_SCRIPT = `
ObjC.import('AppKit');
function run() {
  var pb = $.NSPasteboard.generalPasteboard;
  var data = pb.dataForType($.NSPasteboardTypePNG);
  if (!data.js) {
    var tiff = pb.dataForType($.NSPasteboardTypeTIFF);
    if (tiff.js) {
      var bitmap = $.NSBitmapImageRep.imageRepWithData(tiff);
      if (!bitmap.js) throw new Error('Cannot decode clipboard image');
      if (bitmap.pixelsWide * bitmap.pixelsHigh > 64000000) throw new Error('Clipboard image exceeds pixel limit');
      data = bitmap.representationUsingTypeProperties($.NSPNGFileType, $({}));
      if (!data.js) throw new Error('Cannot encode clipboard image');
    }
  }
  if (data.js) {
    if (data.length > 20971520) throw new Error('Clipboard image exceeds 20 MiB');
    return JSON.stringify({kind:'image', base64:ObjC.unwrap(data.base64EncodedStringWithOptions(0))});
  }
  var text = pb.stringForType($.NSPasteboardTypeString);
  return JSON.stringify(text.js ? {kind:'text', text:ObjC.unwrap(text)} : {kind:'empty'});
}`;

export const WINDOWS_CLIPBOARD_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -ne $image) {
  $stream = [System.IO.MemoryStream]::new()
  try {
    if ([long]$image.Width * $image.Height -gt 64000000) { throw 'Clipboard image exceeds pixel limit' }
    $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    if ($stream.Length -gt 20971520) { throw 'Clipboard image exceeds 20 MiB' }
    @{kind='image'; base64=[Convert]::ToBase64String($stream.ToArray())} | ConvertTo-Json -Compress
  } finally { $stream.Dispose(); $image.Dispose() }
} elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {
  @{kind='text'; text=[System.Windows.Forms.Clipboard]::GetText()} | ConvertTo-Json -Compress
} else { @{kind='empty'} | ConvertTo-Json -Compress }
`;

export function clipboardReadCommand(platform: NodeJS.Platform): { command: string; args: string[] } {
  if (platform === "darwin") return { command: "/usr/bin/osascript", args: ["-l", "JavaScript", "-e", MAC_CLIPBOARD_SCRIPT] };
  if (platform === "win32") return { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(WINDOWS_CLIPBOARD_SCRIPT, "utf16le").toString("base64")] };
  throw new Error("Image clipboard paste requires native macOS or Windows; use a local image path on this platform.");
}

export type ClipboardReadRunner = (command: string, args: readonly string[], signal: AbortSignal) => Promise<string>;

export function createClipboardReadRunner(env: NodeJS.ProcessEnv, timeoutMs = 5000): ClipboardReadRunner {
  return (command, args, signal) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(command, [...args], { env: { ...env }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const abort = (): void => finish(new Error("Clipboard paste cancelled."));
    const timer = setTimeout(() => finish(new Error("Clipboard read timed out.")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) finish(new Error("Clipboard content exceeds the size limit."));
      else if (!settled) chunks.push(chunk);
    });
    // Drain but never display native output: it could contain clipboard contents.
    child.stderr.resume();
    child.once("error", () => finish(new Error("Cannot start the system clipboard reader.")));
    child.once("close", code => finish(code === 0 ? undefined : new Error("System clipboard read failed; check clipboard access and try again.")));
    if (signal.aborted) abort();
  });
}

export function createClipboardPaste(options: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly run?: ClipboardReadRunner;
  readonly tempRoot?: string;
}) {
  const run = options.run ?? createClipboardReadRunner(options.env);
  let directory: string | undefined;
  let closed = false;
  let pending: Promise<string | null> | undefined;
  const read = async (signal: AbortSignal): Promise<string | null> => {
    signal.throwIfAborted();
    if (closed) throw new Error("Clipboard reader is closed.");
    if (options.env.SSH_CONNECTION || options.env.SSH_TTY) throw new Error("Remote clipboard reading is unavailable over SSH; use a remote image path.");
    const command = clipboardReadCommand(options.platform);
    const raw = await run(command.command, command.args, signal);
    signal.throwIfAborted();
    let value: unknown;
    try { value = JSON.parse(raw.replace(/^\uFEFF/, "")); } catch { throw new Error("Invalid response from clipboard reader."); }
    if (!value || typeof value !== "object" || !("kind" in value)) throw new Error("Invalid clipboard content.");
    if (value.kind === "empty") return null;
    if (value.kind === "text" && "text" in value && typeof value.text === "string") {
      if (Buffer.byteLength(value.text) > MAX_TEXT) throw new Error("Clipboard text exceeds 1 MiB.");
      // Never let clipboard control sequences become terminal commands.
      return value.text.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
    }
    if (value.kind !== "image" || !("base64" in value) || typeof value.base64 !== "string" ||
      value.base64.length > Math.ceil(DEFAULT_IMAGE_LIMITS.maxBytes / 3) * 4 ||
      value.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)) {
      throw new Error("Invalid or oversized clipboard image.");
    }
    const data = Buffer.from(value.base64, "base64");
    if (data.toString("base64") !== value.base64) throw new Error("Invalid clipboard image encoding.");
    if (!data.length || data.length > DEFAULT_IMAGE_LIMITS.maxBytes) throw new Error("Clipboard image exceeds size limits.");
    const image = sharp(data, { limitInputPixels: DEFAULT_IMAGE_LIMITS.maxPixels });
    try {
      const meta = await image.metadata();
      if (meta.format !== "png" || !meta.width || !meta.height || Math.max(meta.width, meta.height) > DEFAULT_IMAGE_LIMITS.maxDimension) {
        throw new Error("Invalid image");
      }
      await image.stats();
    } catch { throw new Error("Clipboard image is invalid or exceeds image limits."); }
    signal.throwIfAborted();
    directory ??= await mkdtemp(join(options.tempRoot ?? tmpdir(), "laohuang-clipboard-"));
    const path = join(directory, `${randomUUID()}.png`);
    try {
      await writeFile(path, data, { flag: "wx", mode: 0o600 });
      signal.throwIfAborted();
      // Delimit the path from surrounding prose; JSON quoting preserves spaces/backslashes.
      return ` ${JSON.stringify(path)} `;
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  };
  return {
    read(signal: AbortSignal): Promise<string | null> {
      if (pending) return Promise.reject(new Error("Clipboard paste already in progress."));
      pending = read(signal).finally(() => { pending = undefined; });
      return pending;
    },
    async close(): Promise<void> {
      closed = true;
      await pending?.catch(() => {});
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}
