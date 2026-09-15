export interface SkillEntry {
  readonly name: string;
  readonly description: string;
  readonly providerId: string;
  readonly sourceId: string;
  readonly identity: string;
  readonly location: string;
  readonly priority: number;
  readonly locator: unknown;
}
export interface SkillSnapshot {
  readonly entries: readonly SkillEntry[];
  readonly complete: boolean;
  readonly revision: number;
}
export interface LoadedSkill {
  readonly entry: SkillEntry;
  readonly body: string;
  readonly bodyHash: string;
  readonly resourceBase: string;
}
export interface SkillProvider {
  readonly id: string;
  list(): Promise<{ readonly entries: readonly SkillEntry[]; readonly complete: boolean }>;
  load(entry: SkillEntry, signal?: AbortSignal): Promise<LoadedSkill>;
  onChange(listener: () => void): () => void;
  close(): Promise<void>;
}
export function compareSkillPaths(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
export function isSkillName(value: string): boolean {
  return /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value) && value.length <= 64;
}

/** Source-neutral catalog; providers own all I/O and raw candidate caches. */
export class SkillRegistry {
  private readonly providers = new Map<string, { provider: SkillProvider; unsubscribe: () => void }>();
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private published = -1;
  private entries: readonly SkillEntry[] = [];
  private pending: Promise<SkillSnapshot> | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly report: (message: string) => void;
  constructor(report: (message: string) => void = () => {}) { this.report = report; }
  register(provider: SkillProvider): () => Promise<void> {
    if (this.closed || this.providers.has(provider.id)) throw new Error(`Cannot register Skill source: ${provider.id}`);
    const unsubscribe = provider.onChange(() => this.invalidate());
    this.providers.set(provider.id, { provider, unsubscribe });
    this.invalidate();
    return async () => {
      if (this.providers.get(provider.id)?.provider !== provider) return;
      this.providers.delete(provider.id);
      unsubscribe();
      this.invalidate();
      await provider.close();
    };
  }
  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private invalidate(): void {
    this.generation++;
    for (const listener of this.listeners) listener();
  }
  snapshot(): Promise<SkillSnapshot> {
    if (this.closed) return Promise.reject(new Error("Skill registry is closed"));
    if (this.published === this.generation) return Promise.resolve({ entries: this.entries, complete: true, revision: this.published });
    if (!this.pending) this.pending = this.refresh().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async refresh(): Promise<SkillSnapshot> {
    while (!this.closed) {
      const generation = this.generation;
      const results = await Promise.all([...this.providers.values()].map(async ({ provider }) => {
        try { return await provider.list(); }
        catch (error) { this.report(`Skill discovery failed: ${String(error)}`); return { entries: [], complete: false }; }
      }));
      if (this.closed) throw new Error("Skill registry is closed");
      if (generation !== this.generation) continue;
      if (results.some(result => !result.complete)) return { entries: this.entries, complete: false, revision: this.published };
      const candidates = results.flatMap(result => [...result.entries]).sort((a, b) => a.priority - b.priority || compareSkillPaths(a.location, b.location));
      const names = new Map<string, SkillEntry>();
      const identities = new Set<string>();
      for (const entry of candidates) {
        if (identities.has(entry.identity)) continue;
        identities.add(entry.identity);
        const previous = names.get(entry.name);
        if (previous) this.report(`Skill '${entry.name}' collision: using ${previous.location}; ignored ${entry.location}`);
        else names.set(entry.name, Object.freeze({ ...entry }));
      }
      this.entries = Object.freeze([...names.values()].sort((a, b) => compareSkillPaths(a.name, b.name)));
      this.published = generation;
      return { entries: this.entries, complete: true, revision: generation };
    }
    throw new Error("Skill registry is closed");
  }
  async load(name: string, signal?: AbortSignal): Promise<LoadedSkill> {
    signal?.throwIfAborted();
    const snapshot = await this.snapshot();
    signal?.throwIfAborted();
    if (!snapshot.complete) throw new Error("Skill discovery is incomplete; retry after the source is readable");
    const entry = snapshot.entries.find(item => item.name === name);
    const provider = entry && this.providers.get(entry.providerId)?.provider;
    if (!entry || !provider) throw new Error(`Skill '${name}' is unknown or no longer available`);
    const loaded = await provider.load(entry, signal);
    signal?.throwIfAborted();
    if (this.closed || this.providers.get(entry.providerId)?.provider !== provider) throw new Error("Skill source changed during loading");
    if (snapshot.revision !== this.generation) {
      const current = await this.snapshot();
      const winner = current.entries.find(item => item.name === name);
      if (!current.complete || !winner || winner.providerId !== entry.providerId || winner.sourceId !== entry.sourceId || winner.identity !== entry.identity || winner.location !== entry.location) {
        throw new Error("Skill source changed during loading; retry");
      }
    }
    return loaded;
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      const providers = [...this.providers.values()];
      this.providers.clear(); this.listeners.clear();
      for (const item of providers) item.unsubscribe();
      const results = await Promise.allSettled(providers.map(item => item.provider.close()));
      await this.pending?.catch(() => {});
      const errors = results.filter(item => item.status === "rejected").map(item => item.reason);
      if (errors.length) throw new AggregateError(errors, "Cannot close Skill sources");
    })();
  }
}
