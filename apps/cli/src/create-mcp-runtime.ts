import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { createMcpService, parseMcpConfig, resolveMcpServers, validateMcpEnvironment, type McpService, type McpConfigSource } from "@laohuang/mcp";
import { McpConfigStore, McpCredentialFileStore } from "@laohuang/local-config";
import type { ToolRegistry } from "@laohuang/tools";
import type { CommandPresenter } from "./command-presentation.ts";

export interface CreateMcpRuntimeOptions {
  configPath: string;
  projectRoot: string;
  version: string;
  registry: ToolRegistry;
  presenter: CommandPresenter;
  env: Readonly<Record<string, string | undefined>>;
  toolsChanged?: () => void;
}
export interface McpRuntime {
  readonly service: McpService;
  start(): Promise<void>;
  prepareTools(signal?: AbortSignal): Promise<void>;
  reload(): Promise<void>;
  login(id: string): Promise<void>;
  cancelAuthorization(): boolean;
  close(): Promise<void>;
}

export async function createMcpRuntime(options: CreateMcpRuntimeOptions): Promise<McpRuntime> {
  const directory = dirname(resolve(options.configPath));
  const paths = [...new Set([join(directory, "mcp.json"), resolve(options.projectRoot, ".laohuang/mcp.json")])];
  const readSources = async (reload: boolean): Promise<McpConfigSource[]> => {
    const sources: McpConfigSource[] = [];
    let invalid = false;
    for (const path of paths) {
      try {
        const value = await new McpConfigStore(path).read();
        if (value !== undefined) {
          const document = parseMcpConfig(value);
          validateMcpEnvironment(document, options.env);
          sources.push({ path, value: document });
        }
      } catch (error) {
        invalid = true;
        options.presenter.notice({ text: `${path}: ${error instanceof Error ? error.message : "Invalid MCP configuration"}`, tone: "error" });
      }
    }
    if (reload && invalid) throw new Error("MCP reload rejected; previous configuration remains active.");
    return sources;
  };
  const cancel = () => { service.cancelAuthorization(); };
  const showAuthorization = (id: string, url: string) => options.presenter.notice({ text: `Open this URL to authorize MCP ${id}:\n${url}`, tone: "info" });
  const service = createMcpService({
    servers: resolveMcpServers(await readSources(false)), projectRoot: options.projectRoot,
    version: options.version, env: options.env,
    credentials: new McpCredentialFileStore(join(directory, "mcp-credentials")),
    artifactRoot: join(directory, "mcp-artifacts", randomUUID()),
    onAuthorization: ({ serverId, url }) => showAuthorization(serverId, url),
    onLoginState: active => { if (active) process.on("SIGINT", cancel); else process.off("SIGINT", cancel); },
    onToolsChanged: (owner, tools) => {
      if (tools.length === 0) options.registry.removeOwner(owner);
      else options.registry.replaceOwner(owner, tools);
      try { options.toolsChanged?.(); } catch { /* Rendering cannot prevent transport cleanup. */ }
    },
    onStatus: status => {
      if (status.state === "connecting" || status.state === "closed") return;
      options.presenter.notice({ text: `MCP ${status.id}: ${status.state}, ${status.toolCount} tools${status.error ? `. ${status.error}` : ""}`,
        tone: status.state === "ready" ? "info" : "warning" });
    },
  });
  let closed = false;
  return {
    service,
    start: () => service.start(),
    prepareTools: signal => service.waitUntilReady(signal),
    reload: async () => { const sources = await readSources(true); await service.reload(resolveMcpServers(sources)); },
    async login(id) {
      if (closed) throw new Error("MCP runtime is closed");
      await service.login(id, url => showAuthorization(id, url));
    },
    cancelAuthorization: () => service.cancelAuthorization(),
    async close() { closed = true; service.cancelAuthorization(); await service.close(); process.off("SIGINT", cancel); },
  };
}
