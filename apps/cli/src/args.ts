/** Argument parsing for the laohuang CLI. */

export class CliUsageError extends Error {}

export const USAGE =
  "usage: laohuang [--version] [--profile PROFILE] [--model MODEL] " +
  "[--base-url BASE_URL] [--theme {auto,dark,light}] " +
  "[--continue | --resume SESSION_ID] " +
  "[config ...] [doctor] [update]";

export const UPDATE_HELP = `usage: laohuang update

Update the current npm installation of laohuang`;

export const HELP = `${USAGE}

A minimal coding agent

options:
  --version          show program's version number and exit
  -h, --help         show this help message and exit
  --profile PROFILE  model profile for this session
  --model MODEL      model override for this session
  --base-url URL     API base URL override for this session
  --theme THEME      interactive terminal theme: auto, dark, light (default: auto)
  --continue         resume the latest session for this project
  --resume ID        resume a specific session id

subcommands:
  config [set|list|use] [target] [--profile P] [--provider P] [--model M] [--base-url U]
  doctor             check local configuration
  update             update the current npm installation`;

export interface ParsedArguments {
  command: "config" | "doctor" | null;
  profile: string | null;
  model: string | null;
  baseUrl: string | null;
  theme: string;
  configAction: "set" | "list" | "use";
  configTarget: string | null;
  configProfile: string;
  provider: string | null;
  configModel: string | null;
  configBaseUrl: string | null;
  continueSession: boolean;
  resumeSessionId: string | null;
}

export type ParseResult =
  | { kind: "version" }
  | { kind: "help" }
  | { kind: "update" }
  | { kind: "update-help" }
  | { kind: "run"; args: ParsedArguments };

function splitOption(token: string): [string, string | undefined] {
  if (token.startsWith("--")) {
    const equals = token.indexOf("=");
    if (equals !== -1) {
      return [token.slice(0, equals), token.slice(equals + 1)];
    }
  }
  return [token, undefined];
}

export function parseArgs(argv: readonly string[]): ParseResult {
  if (argv[0] === "update") {
    if (argv.length === 1) {
      return { kind: "update" };
    }
    if (argv.length === 2 && (argv[1] === "-h" || argv[1] === "--help")) {
      return { kind: "update-help" };
    }
    throw new CliUsageError(`unrecognized arguments: ${argv.slice(1).join(" ")}`);
  }
  const args: ParsedArguments = {
    command: null,
    profile: null,
    model: null,
    baseUrl: null,
    theme: "auto",
    configAction: "set",
    configTarget: null,
    configProfile: "default",
    provider: null,
    configModel: null,
    configBaseUrl: null,
    continueSession: false,
    resumeSessionId: null,
  };
  let index = 0;
  const takeValue = (option: string, inline: string | undefined): string => {
    if (inline !== undefined) {
      return inline;
    }
    index += 1;
    const value = argv[index];
    if (value === undefined) {
      throw new CliUsageError(`argument ${option}: expected one argument`);
    }
    return value;
  };

  for (; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "config" || token === "doctor") {
      args.command = token;
      index += 1;
      break;
    }
    const [name, inline] = splitOption(token);
    switch (name) {
      case "--version":
        return { kind: "version" };
      case "-h":
      case "--help":
        return { kind: "help" };
      case "--profile":
        args.profile = takeValue(name, inline);
        break;
      case "--model":
        args.model = takeValue(name, inline);
        break;
      case "--base-url":
        args.baseUrl = takeValue(name, inline);
        break;
      case "--theme": {
        const theme = takeValue(name, inline);
        if (theme !== "auto" && theme !== "dark" && theme !== "light") {
          throw new CliUsageError(
            `argument --theme: invalid choice: '${theme}' (choose from 'auto', 'dark', 'light')`,
          );
        }
        args.theme = theme;
        break;
      }
      case "--continue":
        args.continueSession = true;
        break;
      case "--resume":
        args.resumeSessionId = takeValue(name, inline);
        break;
      default:
        throw new CliUsageError(`unrecognized arguments: ${token}`);
    }
  }
  if (args.continueSession && args.resumeSessionId !== null) {
    throw new CliUsageError("--continue and --resume cannot be used together");
  }

  if (args.command === "config") {
    const positionals: string[] = [];
    for (; index < argv.length; index += 1) {
      const token = argv[index]!;
      const [name, inline] = splitOption(token);
      switch (name) {
        case "--profile":
          args.configProfile = takeValue(name, inline);
          break;
        case "--provider": {
          const provider = takeValue(name, inline);
          if (provider.length === 0) {
            throw new CliUsageError("argument --provider: expected one argument");
          }
          args.provider = provider;
          break;
        }
        case "--model":
          args.configModel = takeValue(name, inline);
          break;
        case "--base-url":
          args.configBaseUrl = takeValue(name, inline);
          break;
        case "-h":
        case "--help":
          return { kind: "help" };
        default:
          if (token.startsWith("-")) {
            throw new CliUsageError(`unrecognized arguments: ${token}`);
          }
          positionals.push(token);
      }
    }
    if (positionals.length > 2) {
      throw new CliUsageError(
        `unrecognized arguments: ${positionals.slice(2).join(" ")}`,
      );
    }
    const action = positionals[0];
    if (action !== undefined) {
      if (action !== "set" && action !== "list" && action !== "use") {
        throw new CliUsageError(
          `argument config_action: invalid choice: '${action}' (choose from 'set', 'list', 'use')`,
        );
      }
      args.configAction = action;
    }
    args.configTarget = positionals[1] ?? null;
  } else if (args.command === "doctor") {
    if (index < argv.length) {
      throw new CliUsageError(
        `unrecognized arguments: ${argv.slice(index).join(" ")}`,
      );
    }
  }
  return { kind: "run", args };
}
