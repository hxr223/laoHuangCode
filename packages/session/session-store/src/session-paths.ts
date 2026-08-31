import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export function canonicalProjectRoot(projectRoot: string): string {
  try {
    return realpathSync.native(projectRoot);
  } catch {
    return resolve(projectRoot);
  }
}

export function projectKeyForRoot(projectRoot: string): string {
  const canonical = canonicalProjectRoot(projectRoot);
  const digest = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  return `${sanitizePathPart(basename(canonical) || "project")}-${digest}`;
}

export function ensureSessionDirectory(
  sessionsRoot: string,
  projectKey: string,
): string {
  const directory = join(sessionsRoot, projectKey);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function sessionPathForHeader(
  sessionsRoot: string,
  projectKey: string,
  createdAt: string,
  sessionId: string,
): string {
  const safeCreatedAt = createdAt.replaceAll(":", "").replaceAll(".", "");
  return join(
    ensureSessionDirectory(sessionsRoot, projectKey),
    `${safeCreatedAt}_${sessionId}.jsonl`,
  );
}

function sanitizePathPart(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "project";
}
