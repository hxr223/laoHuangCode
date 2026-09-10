export type PendingInputKind = "escape" | "sequence" | "negotiation" | "paste" | "none";

export function inputTimeout(kind: PendingInputKind, env: NodeJS.ProcessEnv = process.env): number | null {
  if (kind === "none" || kind === "paste") return null;
  if (kind === "negotiation") return 150;
  if (kind === "sequence") return 50;
  const configured = Number(env.LAOHUANG_ESC_TIMEOUT);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT ? 100 : 10;
}

export interface DrainableInput {
  on(event: "data", listener: (data: Uint8Array) => void): unknown;
  off?(event: "data", listener: (data: Uint8Array) => void): unknown;
  pause?(): unknown;
}

/** Called after disabling keyboard reporting, while input is still in raw mode. */
export async function drainTerminalInput(input: DrainableInput | undefined, maxMs = 1000, idleMs = 50): Promise<void> {
  if (!input?.off) return;
  await new Promise<void>((resolve) => {
    let idle: ReturnType<typeof setTimeout>;
    const finish = (): void => {
      clearTimeout(idle);
      clearTimeout(deadline);
      input.off?.("data", onData);
      resolve();
    };
    const onData = (): void => { clearTimeout(idle); idle = setTimeout(finish, idleMs); };
    const deadline = setTimeout(finish, maxMs);
    input.on("data", onData);
    idle = setTimeout(finish, idleMs);
  });
}

export function refreshTerminalDimensions(): void {
  if (process.platform === "win32") return;
  try { process.kill(process.pid, "SIGWINCH"); } catch { /* Best effort after suspend/resume. */ }
}

export function supportsTerminalHyperlinks(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LAOHUANG_HYPERLINKS !== undefined) return env.LAOHUANG_HYPERLINKS === "1";
  if (!process.stdout.isTTY || env.TERM === "dumb") return false;
  return Boolean(env.WT_SESSION || env.KITTY_WINDOW_ID || env.VTE_VERSION ||
    ["iTerm.app", "WezTerm", "vscode", "ghostty"].includes(env.TERM_PROGRAM ?? ""));
}
