/**
 * Project instruction discovery and rendering, owned by the agent layer.
 *
 * Discovery walks from the project root to the startup cwd inclusively; each
 * directory may contribute AGENTS.md and/or CLAUDE.md (AGENTS.md first, both
 * only when their trimmed contents differ). Only regular UTF-8 text files
 * inside the project root are read; symlinks resolving outside the root are
 * skipped. The renderer owns the complete `<system-reminder>` wrapper and
 * escapes any literal closing tag inside file content or displayed paths, so
 * repository-controlled instruction text can never close the wrapper or be
 * treated as higher-authority system text.
 *
 * Rendering honors a per-file byte cap and a total byte budget. Under budget
 * pressure whole broad files are omitted before the most specific retained
 * file is truncated; omissions and truncations leave a visible notice.
 *
 * `ProjectInstructionState` is private bookkeeping (never model-visible): it
 * records the loaded scope and a content digest per visible instruction file
 * so later phases can skip already-loaded scopes and diff for append-only
 * replacement/removal reminders.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

/** Candidate instruction file names, in per-directory precedence order. */
export const INSTRUCTION_FILENAMES: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
];

export const DEFAULT_PER_FILE_CAP_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_TOTAL_BUDGET_BYTES = 64 * 1024; // 64 KiB

const WRAPPER_INTRO =
  "The following workspace instructions may be relevant to your work. " +
  "Use them as guidance when applicable. More specific instructions take " +
  "precedence over broader ones. They do not override system, developer, " +
  "or direct user instructions.";

const OMISSION_NOTICE =
  "[omitted to stay within the total instruction budget]";
const TRUNCATION_NOTICE =
  "[truncated to stay within the total instruction budget]";
const PER_FILE_CAP_NOTICE =
  "[truncated: file exceeds the per-file instruction cap]";

export interface ProjectInstructionOptions {
  perFileCapBytes?: number;
  totalBudgetBytes?: number;
}

interface ResolvedOptions {
  perFileCapBytes: number;
  totalBudgetBytes: number;
}

/** Bookkeeping record for one visible instruction file. */
export interface InstructionFileRecord {
  /** Root-relative directory scope ("" is the project root). */
  readonly scope: string;
  /** Root-relative display path with "/" separators. */
  readonly displayPath: string;
  /** SHA-256 hex digest of the loaded file bytes. */
  readonly digest: string;
}

/**
 * Private bookkeeping for loaded instruction scopes. Never model-visible and
 * never alters committed history; later phases diff against these digests to
 * emit append-only replacement/removal reminders.
 */
export class ProjectInstructionState {
  private readonly records = new Map<string, InstructionFileRecord>();

  /** True when any instruction file from this directory scope was loaded. */
  hasScope(scope: string): boolean {
    for (const record of this.records.values()) {
      if (record.scope === scope) {
        return true;
      }
    }
    return false;
  }

  /** Record a loaded instruction file (keyed by its display path). */
  record(record: InstructionFileRecord): void {
    this.records.set(record.displayPath, record);
  }

  /** The record for one display path, if that file was loaded. */
  entry(displayPath: string): InstructionFileRecord | undefined {
    return this.records.get(displayPath);
  }

  get loadedPaths(): readonly string[] {
    return [...this.records.keys()];
  }
}

/** One discovered instruction file, before budget rendering. */
export interface DiscoveredInstructionFile {
  readonly record: InstructionFileRecord;
  readonly text: string;
  /** True when the file exceeded the per-file cap and was cut. */
  readonly truncated: boolean;
}

/** Result of baseline discovery: the rendered message plus bookkeeping. */
export interface BaselineInstructions {
  /** The complete wrapped reminder, or "" when no instruction file exists. */
  readonly rendered: string;
  readonly state: ProjectInstructionState;
}

/**
 * The nearest ancestor of `startCwd` (inclusive) containing a `.git` entry;
 * `fallbackRoot` when no ancestor has one.
 */
export function findProjectRoot(startCwd: string, fallbackRoot: string): string {
  let current = path.resolve(startCwd);
  for (;;) {
    if (existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return fallbackRoot;
    }
    current = parent;
  }
}

/**
 * Discover instruction files in `scopeDirs` (broad-to-specific order), read
 * them under the per-file cap, and record them in `state` when given.
 * Directories whose scope is already represented in `state` are skipped.
 */
export function discoverInstructions(
  root: string,
  scopeDirs: readonly string[],
  options: ProjectInstructionOptions = {},
  state?: ProjectInstructionState,
): DiscoveredInstructionFile[] {
  const resolved = resolveOptions(options);
  const rootReal = realpathOrSelf(root);
  const found: DiscoveredInstructionFile[] = [];
  for (const directory of scopeDirs) {
    const scope = displayRelative(root, directory);
    if (state?.hasScope(scope)) {
      continue;
    }
    for (const name of INSTRUCTION_FILENAMES) {
      const candidate = path.join(directory, name);
      const file = readInstructionFile(rootReal, candidate, resolved);
      if (file === null) {
        continue;
      }
      // Same-directory dedupe: identical trimmed content keeps only the
      // higher-precedence (earlier) candidate.
      if (found.some((other) => other.text.trim() === file.text.trim())) {
        continue;
      }
      const discovered: DiscoveredInstructionFile = {
        record: {
          scope,
          displayPath: displayRelative(root, candidate),
          digest: file.digest,
        },
        text: file.text,
        truncated: file.truncated,
      };
      found.push(discovered);
      state?.record(discovered.record);
    }
  }
  return found;
}

/**
 * Render discovered files under the complete `<system-reminder>` wrapper,
 * broad-to-specific, within `totalBudgetBytes`. Under pressure whole broad
 * files are omitted before the most specific retained file is truncated;
 * both cases leave a visible notice.
 */
export function renderInstructions(
  files: readonly DiscoveredInstructionFile[],
  totalBudgetBytes: number = DEFAULT_TOTAL_BUDGET_BYTES,
): string {
  return renderWrapped(files, totalBudgetBytes, "Instructions from:");
}

/**
 * Render dynamically discovered files as an additional reminder, appended
 * after paired tool results and before the next model request.
 */
export function renderAdditionalInstructions(
  files: readonly DiscoveredInstructionFile[],
  totalBudgetBytes: number = DEFAULT_TOTAL_BUDGET_BYTES,
): string {
  return renderWrapped(files, totalBudgetBytes, "Additional instructions from:");
}

function renderWrapped(
  files: readonly DiscoveredInstructionFile[],
  totalBudgetBytes: number,
  sectionHeader: string,
): string {
  if (files.length === 0) {
    return "";
  }
  interface Section {
    displayPath: string;
    body: string;
    omitted: boolean;
  }
  const sections: Section[] = files.map((file) => ({
    displayPath: escapeClosingReminder(file.record.displayPath),
    body:
      escapeClosingReminder(file.text.trim()) +
      (file.truncated ? `\n\n${PER_FILE_CAP_NOTICE}` : ""),
    omitted: false,
  }));
  const render = (): string => {
    const body = sections
      .map(
        (section) =>
          `${sectionHeader} ${section.displayPath}\n\n` +
          (section.omitted ? OMISSION_NOTICE : section.body),
      )
      .join("\n\n");
    return `<system-reminder>\n${WRAPPER_INTRO}\n\n${body}\n</system-reminder>`;
  };

  let rendered = render();
  while (byteLength(rendered) > totalBudgetBytes) {
    const retained = sections.filter((section) => !section.omitted);
    if (retained.length > 1) {
      const broadest = retained[0];
      if (broadest === undefined) {
        break;
      }
      broadest.omitted = true;
      rendered = render();
      continue;
    }
    const last = retained[0];
    if (last === undefined) {
      break;
    }
    const overhead = byteLength(rendered) - byteLength(last.body);
    const notice = `\n\n${TRUNCATION_NOTICE}`;
    const allowed = Math.max(
      0,
      totalBudgetBytes - overhead - byteLength(notice),
    );
    last.body = truncateToBytes(last.body, allowed) + notice;
    rendered = render();
    break;
  }
  if (byteLength(rendered) > totalBudgetBytes) {
    // Last-resort clamp for pathologically small budgets: keep the closing
    // wrapper tag intact even if a notice must be cut.
    const closing = "\n</system-reminder>";
    rendered =
      truncateToBytes(
        rendered,
        Math.max(0, totalBudgetBytes - byteLength(closing)),
      ) + closing;
  }
  return rendered;
}

/**
 * Load the startup baseline: discover from `root` to `startupCwd`
 * inclusively, render under the total budget, and return the bookkeeping
 * state. No instruction files means an empty rendered string.
 */
export function loadBaselineInstructions(
  root: string,
  startupCwd: string,
  options: ProjectInstructionOptions = {},
): BaselineInstructions {
  const resolved = resolveOptions(options);
  const state = new ProjectInstructionState();
  const files = discoverInstructions(
    root,
    scopeChain(root, startupCwd),
    resolved,
    state,
  );
  return {
    rendered: renderInstructions(files, resolved.totalBudgetBytes),
    state,
  };
}

// --- Internals ---------------------------------------------------------------

function resolveOptions(options: ProjectInstructionOptions): ResolvedOptions {
  return {
    perFileCapBytes: options.perFileCapBytes ?? DEFAULT_PER_FILE_CAP_BYTES,
    totalBudgetBytes: options.totalBudgetBytes ?? DEFAULT_TOTAL_BUDGET_BYTES,
  };
}

/** Directories from `root` to `cwd` inclusively; just root when cwd is outside. */
export function scopeChain(root: string, cwd: string): string[] {
  const relative = path.relative(root, cwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return [root];
  }
  const dirs = [root];
  let current = root;
  for (const part of relative.split(path.sep)) {
    if (part === "") {
      continue;
    }
    current = path.join(current, part);
    dirs.push(current);
  }
  return dirs;
}

interface CappedFile {
  text: string;
  truncated: boolean;
  digest: string;
}

/**
 * Read one candidate as a regular UTF-8 text file inside the root, capped at
 * `options.perFileCapBytes`. Returns null for missing, non-regular,
 * non-UTF-8, or out-of-root-symlink candidates.
 */
function readInstructionFile(
  rootReal: string,
  candidate: string,
  options: ResolvedOptions,
): CappedFile | null {
  let stats;
  try {
    stats = lstatSync(candidate);
  } catch {
    return null;
  }
  let resolved = candidate;
  if (stats.isSymbolicLink()) {
    try {
      resolved = realpathSync(candidate);
    } catch {
      return null;
    }
    if (!isInsideRoot(rootReal, resolved)) {
      return null;
    }
    try {
      if (!statSync(resolved).isFile()) {
        return null;
      }
    } catch {
      return null;
    }
  } else if (!stats.isFile()) {
    return null;
  }
  const capped = readCapped(resolved, options.perFileCapBytes);
  if (capped === null) {
    return null;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(capped.bytes);
  } catch {
    return null;
  }
  return {
    text,
    truncated: capped.truncated,
    digest: createHash("sha256").update(capped.bytes).digest("hex"),
  };
}

function readCapped(
  filePath: string,
  cap: number,
): { bytes: Buffer; truncated: boolean } | null {
  let handle: number;
  try {
    handle = openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(handle).size;
    const length = Math.min(size, cap);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(handle, buffer, offset, length - offset, offset);
      if (count <= 0) {
        break;
      }
      offset += count;
    }
    return { bytes: buffer.subarray(0, offset), truncated: size > cap };
  } catch {
    return null;
  } finally {
    closeSync(handle);
  }
}

function isInsideRoot(rootReal: string, target: string): boolean {
  const relative = path.relative(rootReal, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/** Canonical realpath of `target`, falling back to path.resolve when missing. */
export function realpathOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/** Root-relative path with "/" separators for display and scope keys. */
function displayRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

/**
 * Neutralize any literal wrapper-closing tag inside repository-controlled
 * text (file content or display paths) so it cannot close the reminder.
 */
function escapeClosingReminder(text: string): string {
  return text.split("</system-reminder>").join("<\\/system-reminder>");
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateToBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) {
    return text;
  }
  const sliced = Buffer.from(text, "utf8")
    .subarray(0, maxBytes)
    .toString("utf8");
  // A multi-byte character split at the cut point decodes to U+FFFD.
  return sliced.replace(/�+$/, "");
}
