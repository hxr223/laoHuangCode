import { CancelToken } from "@laohuang/runtime-protocol";
import { ToolRegistry, touchedPathOf } from "@laohuang/tools";
import { createFileToolDefinitions } from "@laohuang/tool-fs";
import { createBashToolDefinition } from "@laohuang/tool-bash";
const token = new CancelToken();
const tools = new ToolRegistry([
  ...createFileToolDefinitions({ projectRoot: "/workspace" }),
  createBashToolDefinition({
    projectRoot: "/workspace",
    bashTimeoutSeconds: 60,
  }),
]);
process.on("message", async (message: unknown) => {
  if (!message || typeof message !== "object") return;
  const value = message as {
    type?: string;
    name?: string;
    args?: Record<string, unknown>;
  };
  if (value.type === "cancel") {
    token.cancel("evaluation cancelled");
    return;
  }
  if (value.type !== "execute" || !value.name || !value.args) return;
  const result = await tools.execute(value.name, value.args, {
    isCancelled: () => token.isCancelled(),
    cancellationReason: "evaluation cancelled",
    publish: (kind, payload) =>
      new Promise<void>((resolve) =>
        process.send?.({ type: "event", kind, payload }, () => resolve()),
      ),
  });
  process.send?.(
    { type: "result", result, touchedPath: touchedPathOf(result) },
    () => process.disconnect(),
  );
});
