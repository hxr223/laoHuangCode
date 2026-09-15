import { lstat, readFile, readlink, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { WatchHandle, WatchService } from "@laohuang/file-watcher";
import { compareSkillPaths, type SkillEntry, type SkillProvider, type LoadedSkill } from "@laohuang/skill";
import { parseSkill, SkillParseError } from "./parser.ts";
export { parseSkill, SkillParseError } from "./parser.ts";

export interface SkillRoot { readonly path: string; readonly priority: number }
interface RootState {
  readonly root: SkillRoot;
  entries: readonly SkillEntry[];
  generation: number;
  scanned: number;
  complete: boolean;
  readonly watches: Map<string, WatchHandle>;
}
export function skillRoots(projectRoot: string, home: string, extras: readonly string[]): SkillRoot[] {
  return [
    { path: join(projectRoot, ".laohuang/skills"), priority: 100 },
    { path: join(projectRoot, ".agents/skills"), priority: 200 },
    ...extras.map((path, index) => ({ path, priority: 300 + index / (extras.length + 1) })),
    { path: join(home, ".laohuang/skills"), priority: 400 },
    { path: join(home, ".agents/skills"), priority: 500 },
  ];
}
export function parseSkillDirs(value: unknown, configPath: string, home: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) throw new Error("Configuration skillDirs must be an array of non-empty paths");
  return [...new Set((value as string[]).map(item => {
    const path = item.trim();
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new Error("skillDirs accepts local paths, not URLs");
    return path === "~" ? home : path.startsWith("~/") ? resolve(home, path.slice(2)) : resolve(dirname(configPath), path);
  }))];
}
function absent(error: unknown): boolean { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""); }

/** File source owns subscriptions and raw candidates; registry owns merged snapshots. */
export class FileSystemSkillProvider implements SkillProvider {
  readonly id = "filesystem";
  private roots: RootState[] = [];
  private readonly watcher: WatchService;
  private readonly report: (message: string) => void;
  private readonly listeners = new Set<() => void>();
  private pending: Promise<{ entries: readonly SkillEntry[]; complete: boolean }> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly disposals = new Set<Promise<void>>();
  private readonly nodeFilters = new Map<string, (path: string) => boolean>();
  constructor(watcher: WatchService, report: (message: string) => void = () => {}) { this.watcher = watcher; this.report = report; }
  setRoots(roots: readonly SkillRoot[]): void {
    if (this.closed) throw new Error("Skill source is closed");
    const previous = new Map(this.roots.map(state => [state.root.path, state]));
    const unique = new Map<string, SkillRoot>();
    for (const root of roots) if (!unique.has(resolve(root.path))) unique.set(resolve(root.path), { ...root, path: resolve(root.path) });
    if (JSON.stringify([...unique.values()]) === JSON.stringify(this.roots.map(state => state.root))) return;
    this.roots = [...unique.values()].map(root => {
      const old = previous.get(root.path);
      if (old && old.root.priority === root.priority) { previous.delete(root.path); return old; }
      return { root, entries: [], generation: 0, scanned: -1, complete: false, watches: new Map() };
    });
    for (const state of previous.values()) this.disposeState(state);
    this.changed();
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void {
    if (this.closed) return;
    for (const listener of this.listeners) listener();
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.list().catch(error => this.report(String(error))); }, 75);
  }
  invalidatePath(path: string): void {
    for (const state of this.roots) {
      if ([...state.watches.keys()].some(key => { const target = key.slice(2); const rel = relative(target, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); })) state.generation++;
    }
    this.changed();
  }
  list(): Promise<{ entries: readonly SkillEntry[]; complete: boolean }> {
    if (this.closed) return Promise.reject(new Error("Skill source is closed"));
    if (!this.pending) this.pending = this.refresh().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async refresh(): Promise<{ entries: readonly SkillEntry[]; complete: boolean }> {
    for (;;) {
      if (this.closed) throw new Error("Skill source is closed");
      const roots = this.roots;
      const generations = roots.map(state => state.generation);
      for (const state of roots) if (state.scanned !== state.generation || !state.complete) await this.scan(state);
      if (this.roots !== roots || roots.some((state, index) => state.generation !== generations[index])) continue;
      return { entries: roots.flatMap(state => [...state.entries]), complete: roots.every(state => state.complete) };
    }
  }
  private async scan(state: RootState): Promise<void> {
    const generation = state.generation;
    const desired = new Set<string>();
    const entries: SkillEntry[] = [];
    const seen = new Set<string>();
    const watch = async (path: string, directory: boolean): Promise<void> => {
      if (this.closed || !this.roots.includes(state)) throw new Error("Skill source removed");
      const key = `${directory ? "d" : "f"}:${path}`;
      desired.add(key);
      let handle = state.watches.get(key);
      if (handle?.state === "failed" || handle?.state === "closed") { state.watches.delete(key); await handle.dispose(); handle = undefined; }
      if (!handle) {
        // The shared service anchors each target at its parent itself. Passing
        // the parent here would unnecessarily watch all of its siblings.
        let ignored = this.nodeFilters.get(path);
        if (!directory && !ignored) { ignored = candidate => candidate !== path; this.nodeFilters.set(path, ignored); }
        handle = this.watcher.watch(path, { recursive: false, ignored: directory ? undefined : ignored });
        state.watches.set(key, handle);
        handle.onDidChange(change => {
          if (this.closed || !this.roots.includes(state)) return;
          if (!directory && change.type === "change" && change.path !== path) return;
          state.generation++; this.changed();
        });
        handle.onError(failure => {
          if (this.closed || !this.roots.includes(state)) return;
          state.complete = false;
          this.report(`Skill watch failed at ${path}: ${failure.error.message}`);
          for (const listener of this.listeners) listener();
        });
      }
      if (handle.state === "recovering") throw new Error(`Skill watcher is recovering: ${path}`);
      let failureSubscription: { dispose(): void } | undefined;
      const failed = new Promise<never>((_, reject) => {
        failureSubscription = handle!.onError(failure => reject(failure.error));
      });
      try { await Promise.race([handle.ready, failed]); }
      finally { failureSubscription?.dispose(); }
      if (handle.state !== "watching") throw new Error(`Skill watcher is not ready: ${path}`);
    };
    // Resolve every link component, keeping link-parent subscriptions even for missing targets.
    const resolveLinks = async (input: string): Promise<string | undefined> => {
      let path = resolve(input);
      const links = new Set<string>();
      for (;;) {
        const root = parse(path).root;
        const parts = path.slice(root.length).split(sep).filter(Boolean);
        let current = root;
        let followed = false;
        for (let index = 0; index < parts.length; index++) {
          current = join(current, parts[index]!);
          let stat;
          try { stat = await lstat(current); }
          catch (error) { if (!absent(error)) throw error; await watch(current, false); return undefined; }
          if (!stat.isSymbolicLink()) continue;
          await watch(current, false);
          const step = `${current}\0${parts.slice(index + 1).join(sep)}`;
          if (links.has(step) || links.size >= 64) { this.report(`Skill link cycle: ${current}`); return undefined; }
          links.add(step);
          const target = resolve(dirname(current), await readlink(current));
          await watch(target, false);
          path = resolve(target, ...parts.slice(index + 1));
          followed = true; break;
        }
        if (!followed) return path;
      }
    };
    const file = async (path: string): Promise<void> => {
      const resolved = await resolveLinks(path);
      if (!resolved) return;
      await watch(resolved, false);
      try {
        const parsed = parseSkill(await readFile(resolved, "utf8"));
        entries.push({ name: parsed.name, description: parsed.description, providerId: this.id, sourceId: state.root.path,
          identity: await realpath(resolved), location: path, priority: state.root.priority, locator: resolved });
      } catch (error) {
        if (error instanceof SkillParseError) this.report(`Skill ${path} ignored: ${error.message}`);
        else if (!absent(error)) throw error;
      }
    };
    const walk = async (path: string, top: boolean): Promise<void> => {
      const resolved = await resolveLinks(path);
      if (!resolved) return;
      const identity = await realpath(resolved);
      if (seen.has(identity)) return;
      seen.add(identity);
      await watch(identity, true);
      let children;
      try { children = await readdir(identity, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      children.sort((a, b) => compareSkillPaths(a.name, b.name));
      if (children.some(child => child.name === "SKILL.md")) { await file(join(path, "SKILL.md")); return; }
      for (const child of children) {
        if (child.name.startsWith(".") || child.name === "node_modules") continue;
        const childPath = join(path, child.name);
        if (child.isDirectory()) await walk(childPath, false);
        else if (child.isSymbolicLink()) {
          const target = await resolveLinks(childPath);
          if (target) {
            const stat = await lstat(target);
            if (stat.isDirectory()) await walk(childPath, false);
            else if (top && stat.isFile() && child.name.endsWith(".md")) await file(childPath);
          }
        } else if (top && child.isFile() && child.name.endsWith(".md")) await file(childPath);
      }
    };
    try {
      await watch(state.root.path, false);
      await walk(state.root.path, true);
      if (this.closed || !this.roots.includes(state) || generation !== state.generation) return;
      state.entries = entries; state.complete = true; state.scanned = generation;
      for (const [key, handle] of state.watches) if (!desired.has(key)) { state.watches.delete(key); await handle.dispose(); }
    } catch (error) {
      state.complete = false;
      if (!this.closed && this.roots.includes(state)) this.report(`Skill scan failed at ${state.root.path}: ${String(error)}`);
    }
  }
  async load(entry: SkillEntry, signal?: AbortSignal): Promise<LoadedSkill> {
    try {
    if (typeof entry.locator !== "string") throw new Error("Invalid Skill locator");
    const currentPath = await realpath(entry.location);
    if (currentPath !== entry.identity) { this.invalidatePath(entry.location); throw new Error("Skill source changed; retry loading"); }
    const parsed = parseSkill(await readFile(currentPath, { encoding: "utf8", signal }));
    if (parsed.name !== entry.name) { this.invalidatePath(entry.location); throw new Error("Skill name changed; retry loading"); }
    return { entry, body: parsed.body, bodyHash: parsed.bodyHash, resourceBase: dirname(currentPath) };
    } catch (error) {
      if (!signal?.aborted && !this.closed) this.invalidatePath(entry.location);
      throw error;
    }
  }
  private disposeState(state: RootState): void {
    const handles = [...state.watches.values()]; state.watches.clear();
    const pending = Promise.allSettled(handles.map(handle => handle.dispose())).then(results => {
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.length) this.report(`Skill watch cleanup failed: ${new AggregateError(errors).message}`);
    });
    this.disposals.add(pending); void pending.finally(() => this.disposals.delete(pending));
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; if (this.timer) clearTimeout(this.timer);
      for (const state of this.roots) this.disposeState(state);
      this.roots = []; this.listeners.clear();
      this.nodeFilters.clear();
      await this.pending?.catch(() => {});
      await Promise.all(this.disposals);
    })();
  }
}
