import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createWatchService, type WatchService } from "@laohuang/file-watcher";
import { SkillRegistry } from "@laohuang/skill";
import { FileSystemSkillProvider, parseSkillDirs, skillRoots } from "@laohuang/skill-filesystem";
import { SkillSession } from "@laohuang/tool-skill";
import type { CommandRegistry } from "./commands.ts";

export interface SkillRuntime {
  readonly registry: SkillRegistry;
  readonly session: SkillSession;
  attachCommands(commands: CommandRegistry): Promise<void>;
  close(): Promise<void>;
}

export async function createSkillRuntime(options: {
  configPath: string;
  projectRoot: string;
  home: string;
  report(message: string): void;
  watcher?: WatchService;
}): Promise<SkillRuntime> {
  const watcher = options.watcher ?? createWatchService();
  const registry = new SkillRegistry(options.report);
  const source = new FileSystemSkillProvider(watcher, options.report);
  const session = new SkillSession(registry);
  const configPath = resolve(options.configPath);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let commands: CommandRegistry | undefined;
  let commandNames: string[] = [];
  let work = Promise.resolve();
  const readConfig = async (): Promise<void> => {
    let document: unknown;
    try { document = JSON.parse(await readFile(configPath, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") document = {};
      else throw new Error(`Cannot read Skill configuration: ${configPath}`);
    }
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("Skill configuration must be an object");
    const extras = parseSkillDirs((document as Record<string, unknown>)["skillDirs"], configPath, options.home);
    if (!closed) source.setRoots(skillRoots(options.projectRoot, options.home, extras));
  };
  const refreshCommands = async (): Promise<void> => {
    const snapshot = await registry.snapshot();
    if (closed || !commands || !snapshot.complete) return;
    for (const name of commandNames) commands.unregister(name);
    commandNames = snapshot.entries.map(entry => `/skill:${entry.name}`);
    for (const entry of snapshot.entries) commands.register({ name: `/skill:${entry.name}`, description: entry.description, usage: `/skill:${entry.name} [arguments]` });
  };
  const schedule = (config: boolean): void => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    configDirty ||= config;
    timer = setTimeout(() => {
      timer = undefined;
      const read = configDirty; configDirty = false;
      work = work.then(async () => { if (closed) return; if (read) await readConfig(); await refreshCommands(); }).catch(error => { if (!closed) options.report(String(error)); });
    }, 100);
  };
  let configDirty = false;
  registry.register(source);
  const unsubscribe = registry.onChange(() => schedule(false));
  const configWatch = watcher.watch(dirname(configPath), { recursive: false });
  configWatch.onDidChange(change => { if (change.type === "invalidate" || change.path === configPath) schedule(true); });
  configWatch.onError(failure => { if (!closed) options.report(`Skill configuration watch: ${failure.error.message}`); });
  const close = async (): Promise<void> => {
    closed = true;
    if (timer) clearTimeout(timer);
    unsubscribe(); session.close();
    for (const name of commandNames) commands?.unregister(name);
    try { await work; await registry.close(); }
    finally { try { await configWatch.dispose(); } finally { if (!options.watcher) await watcher.close(); } }
  };
  try {
    await configWatch.ready;
    // Invalid startup extras do not hide valid default directories.
    source.setRoots(skillRoots(options.projectRoot, options.home, []));
    try { await readConfig(); } catch (error) { options.report(String(error)); }
    await registry.snapshot();
  } catch (error) { await close(); throw error; }
  return {
    registry, session,
    async attachCommands(value) {
      commands = value;
      await refreshCommands();
    },
    close,
  };
}
