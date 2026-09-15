import { randomUUID } from "node:crypto";
import type { ModelMessage, UserModelMessage } from "@laohuang/llm";
import type { ToolAdapterDefinition } from "@laohuang/tools";
import { SkillRegistry, type LoadedSkill } from "@laohuang/skill";

export function parseSkillCommand(input: string): { name: string; arguments: string } | null {
  const match = /^\s*\/skill:([^\s]+)(?:[ \t]|\r?\n)?([\s\S]*)$/.exec(input);
  return match ? { name: match[1]!, arguments: match[2]! } : null;
}

function stamp(skill: LoadedSkill): string {
  return JSON.stringify([skill.entry.providerId, skill.entry.sourceId, skill.entry.identity, skill.resourceBase, skill.bodyHash]);
}

function render(skill: LoadedSkill): string {
  return `Skill: ${skill.entry.name}\nResource base: ${skill.resourceBase}\nResolve relative resource paths against this directory. Read referenced files only when needed; scripts are not executed automatically.\n\n${skill.body}`;
}

function metadata(skill: LoadedSkill) {
  const { name, providerId, sourceId, identity } = skill.entry;
  return { name, providerId, sourceId, identity, resourceBase: skill.resourceBase, bodyHash: skill.bodyHash };
}

interface SessionState {
  loaded: Map<string, string>;
  checkedRevision: number;
  changes: Map<string, string>;
  deliveries: Map<string, string>;
}

/** Session-facing Skill integration. Disk access belongs to the provider. */
export class SkillSession {
  private readonly registry: SkillRegistry;
  private readonly states = new Map<string, SessionState>();
  private readonly pending = new Map<string, { session: SessionState; skill: LoadedSkill }>();
  private state: SessionState = { loaded: new Map(), checkedRevision: -1, changes: new Map(), deliveries: new Map() };
  private closed = false;

  constructor(registry: SkillRegistry) { this.registry = registry; }

  selectSession(id: string): void {
    let state = this.states.get(id);
    if (!state) {
      state = { loaded: new Map(), checkedRevision: -1, changes: new Map(), deliveries: new Map() };
      this.states.set(id, state);
    }
    this.state = state;
    this.pending.clear();
  }

  readonly tool: ToolAdapterDefinition = {
    spec: {
      name: "skill",
      description: "Load the current full instructions of a skill from the available skills catalog.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      promptGuidelines: ["When a listed skill matches the task, load it with the skill tool before following its instructions."],
    },
    execute: async (args, context) => {
      if (typeof args["name"] !== "string") return { ok: false, error: "skill requires a name" };
      const skill = await this.registry.load(args["name"], context.signal);
      if (context.isCancelled() || this.closed) throw new Error("Skill load cancelled");
      const key = randomUUID();
      this.pending.set(key, { session: this.state, skill });
      return { ok: true, content: render(skill), skillReceipt: key, skill: metadata(skill) };
    },
  };

  async prepareInput(input: string, signal?: AbortSignal, inputs?: readonly string[]): Promise<UserModelMessage> {
    if (inputs?.some(part => parseSkillCommand(part))) {
      const prepared: UserModelMessage[] = [];
      for (const part of inputs) prepared.push(await this.prepareInput(part, signal));
      return { role: "user", content: prepared.map(message => message.content).join("\n\n"),
        skillContext: { kind: "activation", input, key: JSON.stringify(prepared.flatMap(message => message.skillContext ? [message.skillContext.key] : [])), skills: prepared.flatMap(message => message.skillContext?.skills ?? []) } };
    }
    const command = parseSkillCommand(input);
    if (!command) return { role: "user", content: input };
    const skill = await this.registry.load(command.name, signal);
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Skill session is closed");
    const key = randomUUID();
    this.pending.set(key, { session: this.state, skill });
    return {
      role: "user",
      content: `${render(skill)}${command.arguments ? `\n\nUser arguments:\n${command.arguments}` : ""}`,
      skillContext: { kind: "activation", key, input, skills: [metadata(skill)] },
    };
  }

  committed(messages: readonly ModelMessage[]): void {
    for (const message of messages) {
      let key: unknown;
      if (message.role === "user" && message.skillContext?.kind === "activation") key = message.skillContext.key;
      if (message.role === "tool-result" && message.toolName === "skill" && !message.isError) {
        try { key = (JSON.parse(message.content) as Record<string, unknown>)["skillReceipt"]; } catch { continue; }
      }
      if (typeof key !== "string") continue;
      const keys: string[] = key.startsWith("[") ? JSON.parse(key) as string[] : [key];
      for (const receiptKey of keys) {
        const receipt = this.pending.get(receiptKey);
        if (!receipt) continue;
        this.pending.delete(receiptKey);
        receipt.session.loaded.set(receipt.skill.entry.name, stamp(receipt.skill));
        receipt.session.checkedRevision = -1;
        receipt.session.deliveries.set(receipt.skill.entry.name, receiptKey);
      }
    }
  }

  async prepareContext(messages: readonly ModelMessage[], signal?: AbortSignal): Promise<readonly UserModelMessage[]> {
    if (this.closed) throw new Error("Skill session is closed");
    const state = this.state;
    const snapshot = await this.registry.snapshot();
    signal?.throwIfAborted();
    if (!snapshot.complete) return [];
    const catalog = snapshot.entries.map(({ name, description }) => ({ name, description }));
    const key = JSON.stringify(catalog);
    const last = [...messages].reverse().find(message => message.role === "user" && message.skillContext?.kind === "catalog");
    const result: UserModelMessage[] = [];
    if ((last?.role === "user" ? last.skillContext?.key : undefined) !== key && (catalog.length > 0 || last !== undefined)) {
      result.push({ role: "user", skillContext: { kind: "catalog", key }, content:
        `Available skills (this complete list replaces earlier skill catalogs). Use skill({name}) to read full current instructions before use.\n${catalog.length ? JSON.stringify(catalog, null, 2) : "No skills are currently available."}` });
    }
    if (state.checkedRevision !== snapshot.revision) {
      const changes = new Map<string, string>();
      for (const [name, previous] of state.loaded) {
        if (!catalog.some(entry => entry.name === name)) continue;
        try {
          const current = stamp(await this.registry.load(name, signal));
          if (current !== previous) changes.set(name, current);
        } catch {
          signal?.throwIfAborted();
          // Invalid/deleted skills are handled by catalog replacement, never as a new body.
        }
      }
      state.changes = changes;
      state.checkedRevision = snapshot.revision;
    }
    const changesKey = JSON.stringify([...state.changes].map(([name, version]) => [name, version, state.deliveries.get(name)]));
    const visible = [...messages].reverse().find(message => message.role === "user" && message.skillContext?.kind === "invalidation");
    if (state.changes.size > 0 && (visible?.role === "user" ? visible.skillContext?.key : undefined) !== changesKey) {
      result.push({ role: "user", skillContext: { kind: "invalidation", key: changesKey }, content:
        `Previously loaded skills changed: ${[...state.changes.keys()].join(", ")}. Their earlier instructions may be stale. Load each needed skill again with the skill tool; do not reuse its earlier body.` });
    }
    signal?.throwIfAborted();
    if (this.closed || state !== this.state) throw new Error("Skill session changed during preparation");
    return result;
  }

  async completions(): Promise<readonly { name: string; description: string }[]> {
    return (await this.registry.snapshot()).entries.map(({ name, description }) => ({ name: `skill:${name}`, description }));
  }

  close(): void { this.closed = true; this.pending.clear(); this.states.clear(); }
  finishTurn(): void { this.pending.clear(); }
}
