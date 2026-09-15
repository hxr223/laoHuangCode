import { createHash } from "node:crypto";
import { parse } from "yaml";
import { isSkillName } from "@laohuang/skill";

export class SkillParseError extends Error {}
export function parseSkill(text: string): { name: string; description: string; body: string; bodyHash: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) throw new SkillParseError("Missing YAML frontmatter");
  let value: unknown;
  try { value = parse(match[1]!, { maxAliasCount: 100 }); }
  catch (error) { throw new SkillParseError(`Invalid YAML: ${String(error)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SkillParseError("Frontmatter must be an object");
  const { name, description } = value as Record<string, unknown>;
  if (typeof name !== "string" || !isSkillName(name)) throw new SkillParseError("Invalid or missing name (use up to 64 lowercase letters, digits, '-', '_' or '.')");
  if (typeof description !== "string" || !description.trim()) throw new SkillParseError("Missing description");
  const body = text.slice(match[0].length).trim();
  return { name, description: description.trim(), body, bodyHash: createHash("sha256").update(body).digest("hex") };
}
