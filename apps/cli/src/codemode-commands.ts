import { isCodeMode, type CodeMode } from "@laohuang/tools";
import type { CommandSpec } from "./commands.ts";

export function createCodeModeCommand(options: {
  getMode(): CodeMode;
  setMode(mode: CodeMode): void;
  getDefaultMode(): CodeMode;
  setDefaultMode(mode: CodeMode): void | Promise<void>;
  notice(text: string): void;
}): CommandSpec {
  const usage = "/codemode [off|on|only] | /codemode default off|on|only";
  return {
    name: "/codemode", description: "Show or change Code Mode and the new-session default", usage,
    async handler(args) {
      if (!args.length) {
        options.notice(`Code Mode: ${options.getMode()}. New-session default: ${options.getDefaultMode()}.`);
      } else if (args.length === 1 && isCodeMode(args[0])) {
        options.setMode(args[0]);
        options.notice(`Code Mode: ${args[0]}. Applies to the next model request.`);
      } else if (args.length === 2 && args[0] === "default" && isCodeMode(args[1])) {
        await options.setDefaultMode(args[1]);
        options.notice(`New-session Code Mode default: ${args[1]}. Current session: ${options.getMode()}.`);
      } else throw new Error(`Usage: ${usage}`);
      return true;
    },
    *argumentCompleter(args) {
      if (!args.length || args.length === 1 && args[0] === "default") {
        for (const mode of ["off", "on", "only"] as const) yield [mode, mode === "off" ? "Built-in tools" : mode === "on" ? "Scripts and direct tools" : "Ordinary tools through scripts"] as const;
        if (!args.length) yield ["default", "Set the new-session default"] as const;
      }
    },
  };
}
