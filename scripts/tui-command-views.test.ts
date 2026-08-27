import { test } from "node:test";
import assert from "node:assert/strict";

import { HelpView } from "../packages/terminal/tui/src/tui/components/views/help-view.ts";
import {
  ProviderDetailView,
  ProviderStatusView,
} from "../packages/terminal/tui/src/tui/components/views/provider-status-view.ts";
import { QueueStatusView } from "../packages/terminal/tui/src/tui/components/views/queue-status-view.ts";
import { Transcript } from "../packages/terminal/tui/src/tui/components/transcript.ts";
import { EditorState } from "../packages/terminal/tui/src/tui/editor.ts";
import { FrameBuilder } from "../packages/terminal/tui/src/tui/frame-builder.ts";
import { lineText } from "../packages/terminal/tui/src/tui/render-model.ts";
import { createUIState } from "../packages/terminal/tui/src/tui/state.ts";
import {
  createHelpBlock,
  createProviderDetailBlock,
  createProviderListBlock,
  createQueueStatusBlock,
  TranscriptStore,
} from "../packages/terminal/tui/src/tui/transcript-store.ts";
import { PI_DARK } from "../packages/terminal/tui/src/tui/theme.ts";

test("help keeps command names default and descriptions muted", () => {
  const view = new HelpView({
    commands: [{ name: "/model", usage: "/model [provider] [model]", description: "选择模型" }],
  });
  const spans = view.render({ width: 80, theme: PI_DARK }).lines.flatMap((item) => item.spans);
  const usage = spans.find((item) => item.text.includes("/model"));
  const description = spans.find((item) => item.text.includes("选择模型"));

  assert.equal(usage?.style?.foreground, undefined);
  assert.equal(description?.style?.foreground, "muted");
});

test("help stacks usage and description below fifty columns", () => {
  const lines = new HelpView({
    commands: [{ name: "/model", usage: "/model [provider] [model]", description: "选择模型" }],
  }).render({ width: 40, theme: PI_DARK }).lines.map(lineText);

  assert.deepEqual(lines, ["/model [provider] [model]", "选择模型"]);
});

test("provider states remain independent", () => {
  const view = new ProviderStatusView({
    providers: [{
      id: "anthropic",
      name: "Anthropic",
      available: true,
      configured: true,
      verified: false,
      source: "stored credential",
    }],
  });

  assert.deepEqual(
    view.render({ width: 80, theme: PI_DARK }).lines.map(lineText),
    ["Anthropic  available  configured  unverified", "stored credential"],
  );
});

test("provider status stacks state fields without clipping its label", () => {
  const lines = new ProviderStatusView({
    providers: [{
      id: "anthropic",
      name: "Anthropic",
      available: true,
      configured: false,
      verified: false,
      source: null,
    }],
  }).render({ width: 12, theme: PI_DARK }).lines.map(lineText);

  assert.deepEqual(lines, ["Anthropic", "available", "unconfigured", "unverified"]);
});

test("provider detail exposes model metadata", () => {
  const lines = new ProviderDetailView({
    id: "anthropic",
    name: "Anthropic",
    available: true,
    configured: true,
    verified: true,
    source: "stored credential",
    dynamicModels: true,
    modelCount: 7,
  }).render({ width: 80, theme: PI_DARK }).lines.map(lineText);

  assert.deepEqual(lines, [
    "Anthropic  available  configured  verified",
    "stored credential",
    "dynamic models  7 models",
  ]);
});

test("queue counters keep numeric values default and stack at narrow widths", () => {
  const view = new QueueStatusView({
    pending: 12,
    pendingTokens: 1200,
    held: 3,
    heldTokens: 300,
    deadLetters: 1,
  });
  const rendered = view.render({ width: 24, theme: PI_DARK });
  const spans = rendered.lines.flatMap((line) => line.spans);

  assert.deepEqual(rendered.lines.map(lineText), [
    "pending  12",
    "pending tokens  1200",
    "held  3",
    "held tokens  300",
    "dead letters  1",
  ]);
  assert.ok(spans.some((item) => item.text === "12" && item.style?.foreground === undefined));
  assert.ok(spans.some((item) => item.text === "pending" && item.style?.foreground === "muted"));
});

test("transcript dispatches each static command result variant", () => {
  const transcript = new Transcript({
    blocks: [
      createHelpBlock("help", [{ name: "/help", usage: "/help", description: "显示帮助" }]),
      createProviderListBlock("providers", [{
        id: "anthropic",
        name: "Anthropic",
        available: true,
        configured: true,
        verified: true,
        source: null,
      }]),
      createProviderDetailBlock("provider", {
        id: "anthropic",
        name: "Anthropic",
        available: true,
        configured: true,
        verified: true,
        source: null,
        dynamicModels: false,
        modelCount: 1,
      }),
      createQueueStatusBlock("queue", {
        pending: 0,
        pendingTokens: 0,
        held: 0,
        heldTokens: 0,
        deadLetters: 0,
      }),
    ],
  });

  assert.deepEqual(transcript.render({ width: 80, theme: PI_DARK }).lines.map(lineText), [
    "/help  显示帮助",
    "Anthropic  available  configured  verified",
    "Anthropic  available  configured  verified",
    "static models  1 model",
    "pending  0  pending tokens  0  held  0  held tokens  0  dead letters  0",
  ]);
});

test("frame fallback projects every static command result variant", () => {
  const transcript = new TranscriptStore();
  transcript.append(createHelpBlock("help", [{
    name: "/help",
    usage: "/help",
    description: "show commands",
  }]));
  transcript.append(createProviderListBlock("providers", [{
    id: "anthropic",
    name: "Anthropic",
    available: true,
    configured: true,
    verified: false,
    source: "stored credential",
  }]));
  transcript.append(createProviderDetailBlock("provider", {
    id: "anthropic",
    name: "Anthropic",
    available: true,
    configured: true,
    verified: true,
    source: "stored credential",
    dynamicModels: true,
    modelCount: 7,
  }));
  transcript.append(createQueueStatusBlock("queue", {
    pending: 12,
    pendingTokens: 1200,
    held: 3,
    heldTokens: 300,
    deadLetters: 1,
  }));

  const text = new FrameBuilder({ state: createUIState(), transcript }).build({
    width: 80,
    editor: new EditorState(),
  }).screen.lines.join("\n");

  assert.ok(text.includes("show commands"));
  assert.ok(text.includes("unverified"));
  assert.ok(text.includes("stored credential"));
  assert.ok(text.includes("dynamic models"));
  assert.ok(text.includes("pending 12"));
});
