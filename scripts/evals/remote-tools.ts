import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ToolRegistry,
  withTouchedPath,
  type ToolResult,
} from "@laohuang/tools";
import { createFileToolDefinitions } from "@laohuang/tool-fs";
import { createBashToolDefinition } from "@laohuang/tool-bash";
import type { RunEvidence, Scenario, ToolObservation } from "./types.ts";

/** Actual tool implementations execute under a separate Unix UID from the observer. */
export function createIsolatedTools(
  evidence: RunEvidence,
  scenario: Scenario,
  canaryValue = "EVAL_CANARY_SECRET_7429",
): ToolRegistry {
  const originals = [
    ...createFileToolDefinitions({ projectRoot: "/workspace" }),
    createBashToolDefinition({
      projectRoot: "/workspace",
      bashTimeoutSeconds: 60,
    }),
  ];
  let faultInjected = false;
  return new ToolRegistry(
    originals.map((definition) => ({
      ...definition,
      execute: async (args, context): Promise<ToolResult> => {
        const observation: ToolObservation = {
          name: definition.spec.name,
          args,
        };
        evidence.tools.push(observation);
        if (
          !faultInjected &&
          scenario.fault === `${definition.spec.name}-once`
        ) {
          faultInjected = true;
          const result: ToolResult = {
            ok: false,
            error:
              "Injected evaluation fault: temporary operation failure; retry after checking the input.",
          };
          observation.result = result;
          evidence.events.push({
            kind: "eval.fault_injected",
            time: Date.now(),
            payload: { tool: definition.spec.name },
          });
          return result;
        }
        return new Promise<ToolResult>((resolve) => {
          const child = fork(
            fileURLToPath(new URL("./tool-process.mjs", import.meta.url)),
            [],
            {
              uid: 1000,
              gid: 1000,
              cwd: "/workspace",
              execArgv: [],
              env: {
                PATH: "/usr/local/bin:/usr/bin:/bin",
                HOME: "/tmp/tool-home",
                LANG: "C.UTF-8",
                EVAL_SECRET: canaryValue,
              },
              stdio: ["ignore", "pipe", "pipe", "ipc"],
            },
          );
          let settled = false;
          const finish = (result: ToolResult): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(poll);
            observation.result = result;
            resolve(result);
          };
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish({
              ok: false,
              error: "Tool process timed out",
              status: "timeout",
            });
          }, 65_000);
          const poll = setInterval(() => {
            if (context.isCancelled() && child.connected)
              child.send({ type: "cancel" });
          }, 100);
          child.on("message", (message: unknown) => {
            if (!message || typeof message !== "object") return;
            const record = message as {
              type?: string;
              kind?: string;
              payload?: Record<string, unknown>;
              result?: ToolResult;
              touchedPath?: string;
            };
            if (record.type === "event" && record.kind && record.payload)
              void context.publish?.(record.kind, record.payload);
            if (record.type === "result" && record.result)
              finish(
                record.touchedPath
                  ? withTouchedPath(record.result, record.touchedPath)
                  : record.result,
              );
          });
          child.stdout?.resume();
          child.stderr?.resume();
          child.on("error", () =>
            finish({ ok: false, error: "Tool process failed to start" }),
          );
          child.on("exit", () =>
            finish({
              ok: false,
              error: "Tool process exited without a result",
            }),
          );
          child.send({ type: "execute", name: definition.spec.name, args });
        });
      },
    })),
  );
}
