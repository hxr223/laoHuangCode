import type { StyleToken } from "./render-model.ts";

/**
 * Pi-inspired color tokens shared by the interactive terminal renderers.
 *
 * Hand-written ANSI: themes only carry hex tokens; conversion to SGR
 * sequences happens here instead of going through a styling library.
 */

export class TerminalTheme {
  /** Semantic colors for terminal UI, independent from a rendering library. */

  readonly name: string;
  readonly colors: Readonly<Record<ThemeToken, string>> & Readonly<Record<string, string>>;

  constructor(name: string, colors: Record<ThemeToken, string>) {
    this.name = name;
    this.colors = Object.freeze({ ...colors });
  }

  color(token: StyleToken): string;
  color(token: string): string;
  color(token: string): string {
    const value = this.colors[token];
    if (value === undefined) {
      throw new Error(`unknown theme token: ${token}`);
    }
    return value;
  }

  /** Truecolor SGR sequence for a token, foreground or background. */
  sgr(token: StyleToken, options?: { background?: boolean }): string;
  sgr(token: StyleToken, options?: { background?: boolean }): string {
    const hex = this.color(token);
    const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!match) {
      throw new Error(`theme token ${token} is not a #rrggbb color: ${hex}`);
    }
    const value = match[1] as string;
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    const channel = options?.background ? 48 : 38;
    return `\x1b[${channel};2;${r};${g};${b}m`;
  }
}

type ThemeToken = StyleToken | "border" | "border_muted";

export const DEFAULT_DARK_THEME = new TerminalTheme("dark", {
  accent: "#8abeb7",
  border: "#5f87ff",
  border_muted: "#505050",
  text: "#d4d4d4",
  muted: "#808080",
  dim: "#666666",
  success: "#b5bd68",
  error: "#cc6666",
  warning: "#ffff00",
  user_bg: "#343541",
  tool_pending_bg: "#282832",
  tool_success_bg: "#283228",
  tool_error_bg: "#3c2828",
  card: "#1e1e24",
  code: "#b5bd68",
  heading: "#f0c674",
  link: "#81a2be",
  thinking: "#808080",
  bash: "#b5bd68",
});

export const DEFAULT_LIGHT_THEME = new TerminalTheme("light", {
  accent: "#5a8080",
  border: "#547da7",
  border_muted: "#b0b0b0",
  text: "#1f2328",
  muted: "#6c6c6c",
  dim: "#767676",
  success: "#588458",
  error: "#aa5555",
  warning: "#9a7326",
  user_bg: "#e8e8e8",
  tool_pending_bg: "#e8e8f0",
  tool_success_bg: "#e8f0e8",
  tool_error_bg: "#f0e8e8",
  card: "#ffffff",
  code: "#588458",
  heading: "#9a7326",
  link: "#547da7",
  thinking: "#6c6c6c",
  bash: "#588458",
});

/** Resolve an explicit Pi-style theme, defaulting from terminal settings. */
export function resolveTerminalTheme(
  name?: string | null,
  env: { COLORFGBG?: string | undefined } = process.env,
): TerminalTheme {
  const requested = (name ?? "auto").trim().toLowerCase() || "auto";
  if (requested === "light") {
    return DEFAULT_LIGHT_THEME;
  }
  if (requested === "dark") {
    return DEFAULT_DARK_THEME;
  }
  if (requested !== "auto") {
    throw new Error("terminal theme must be 'auto', 'dark', or 'light'");
  }

  const colorfgbg = env.COLORFGBG ?? "";
  const background = colorfgbg ? (colorfgbg.split(";").pop() as string) : "";
  // Mirror Python int(): optional sign and surrounding whitespace, digits only.
  if (/^\s*[+-]?\d+\s*$/.test(background)) {
    return parseInt(background, 10) >= 7 ? DEFAULT_LIGHT_THEME : DEFAULT_DARK_THEME;
  }
  return DEFAULT_DARK_THEME;
}
