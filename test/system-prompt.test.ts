import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { CodingAgent, type ChatClientLike } from "../src/agent.ts";
import { buildSystemPrompt } from "../src/system-prompt.ts";
import { ToolRegistry } from "../src/tools.ts";

const EXPECTED_PROMPT = `You are laoHuangCode, a coding agent.

General guidelines:
- Work only within the configured project root.
- Follow direct user instructions. Project instructions may provide additional guidance.
- Inspect relevant files before changing them.
- Prefer the smallest change that fully satisfies the request.
- Verify changes when practical.
- Keep the final response concise and state what changed.

Tool guidelines:

## read
- Use read for ordinary file inspection rather than cat/sed.
- Use offset/limit to page through large files.
- Inspect an existing file before changing it.

## write
- Use write only to create a file or replace all of one; use edit for local changes.
- Confirm the path and the complete content before writing.

## edit
- Use edit for local changes; targets must exactly and uniquely match the original file.
- Edits in one batch are matched against the original content and must not overlap.
- Inspect the file first and verify the change when practical.

## bash
- Supply a concise description of what the command does.
- Use workdir instead of cd.
- Each call runs in an independent shell; state does not persist between calls.
- On a non-zero exit, inspect the output before retrying.`;

async function makeTempDir(t: import("node:test").TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("built prompt matches the stable snapshot", async (t) => {
  const tools = new ToolRegistry(await makeTempDir(t));

  assert.equal(buildSystemPrompt(tools), EXPECTED_PROMPT);
});

test("tool sections appear in the fixed read/write/edit/bash order", async (t) => {
  const tools = new ToolRegistry(await makeTempDir(t));
  const prompt = buildSystemPrompt(tools);

  const positions = ["## read", "## write", "## edit", "## bash"].map(
    (section) => prompt.indexOf(section),
  );
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
  );
});

test("prompt is deterministic across builds", async (t) => {
  const tools = new ToolRegistry(await makeTempDir(t));

  assert.equal(buildSystemPrompt(tools), buildSystemPrompt(tools));
});

test("promptGuidelines never leaks into the tools payload", async (t) => {
  const tools = new ToolRegistry(await makeTempDir(t));
  const payload = JSON.stringify(tools.definitions);

  assert.ok(!payload.includes("promptGuidelines"));
  for (const spec of tools.orderedSpecs) {
    for (const guideline of spec.promptGuidelines) {
      assert.ok(!payload.includes(guideline));
    }
  }
});

test("tools payload is deterministic in order and content", async (t) => {
  const tools = new ToolRegistry(await makeTempDir(t));

  assert.equal(
    JSON.stringify(tools.definitions),
    JSON.stringify(tools.definitions),
  );
  assert.deepEqual(
    tools.definitions.map((definition) => definition.function.name),
    ["read", "write", "edit", "bash"],
  );
});

test("agent history starts with the built system prompt", async (t) => {
  const tools = new ToolRegistry(await makeTempDir(t));
  const client = {
    chat: { completions: {} },
  } as unknown as ChatClientLike;
  const agent = new CodingAgent({ client, model: "test-model", tools });

  assert.deepEqual(agent.messages[0], {
    role: "system",
    content: EXPECTED_PROMPT,
  });
});
