import type { CommandSpec } from "./commands.ts";
import type { CommandPresenter } from "./command-presentation.ts";
import type { McpRuntime } from "./create-mcp-runtime.ts";

export function createMcpCommand(runtime: McpRuntime, presenter: CommandPresenter): CommandSpec {
  const actions = ["status", "reload", "reconnect", "login", "logout"];
  const usage = "/mcp status | reload | reconnect <server> | login <server> | logout <server>";
  return {
    name: "/mcp", description: "管理 MCP 连接、工具和认证", usage,
    argumentCompleter: args => args.length <= 1 ? actions.map(value => [value, "MCP"] as const)
      : ["reconnect", "login", "logout"].includes(args[0] ?? "") && args.length === 2
        ? runtime.service.status().map(status => [status.id, status.state] as const) : [],
    async handler(args) {
      const action = args[0] ?? "status";
      const needsId = ["reconnect", "login", "logout"].includes(action);
      if (!actions.includes(action) || (needsId ? args.length !== 2 : args.length > 1)) {
        presenter.notice({ text: usage, tone: "warning" }); return true;
      }
      try {
        if (action === "reload") await runtime.reload();
        else if (action === "login") await runtime.login(args[1]!);
        else if (action === "logout") await runtime.service.logout(args[1]!);
        else if (action === "reconnect") await runtime.service.reconnect(args[1]!);
        const statuses = runtime.service.status();
        presenter.notice({ text: statuses.length === 0 ? "No MCP servers configured." : statuses.map(status =>
          `${status.id}: ${status.state} · ${status.transport} · ${status.protocolVersion ?? "unnegotiated"} · ${status.toolCount} tools${status.error ? ` · ${status.error}` : ""}`).join("\n"), tone: "info" });
      } catch (error) { presenter.notice({ text: error instanceof Error ? error.message : "MCP operation failed", tone: "error" }); }
      return true;
    },
  };
}
