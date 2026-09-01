import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Runtime import of the TypeScript source: Node type stripping requires the
// real ".ts" extension (".js" specifiers do not resolve to ".ts" files).
import {
  VERSION,
  main as cliMain,
  resetEmptySessionTranscript,
  runInitialModelSelection,
} from "../apps/cli/src/main.ts";
import { parseArgs } from "../apps/cli/src/args.ts";
import {
  runPlainSessionRepl,
  runRepl,
  runSessionRepl,
  supportsTerminalUI,
  type SessionReplSession,
} from "../apps/cli/src/repl.ts";
import { ConfigManager, CredentialStore } from "@laohuang/local-config";
import { EventKind, EventProjector } from "../packages/core/runtime-protocol/src/index.ts";
import {
  ModelSelector,
} from "../apps/cli/src/model-selection.ts";
import type { ModelInfo, ModelProviderInfo } from "@laohuang/llm";
import { PlainCommandPresenter } from "../apps/cli/src/plain-command-presenter.ts";
import {
  FakeCatalog,
  FakeProviderAuth,
} from "./helpers/session-command-fixture.ts";
import { AgentSession } from "@laohuang/session-runtime";
import {
  MemoryTerminalDriver,
  PlainEventSink,
  PromptCancelledError,
  PromptEofError,
  TerminalUI,
} from "../packages/terminal/tui/src/index.ts";
import { RecordingPresenter } from "./helpers/command-presentation-fixture.ts";

const textEncoder = new TextEncoder();

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../apps/cli/dist/bin.js", import.meta.url));

const providerInfos: readonly ModelProviderInfo[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    authName: "DeepSeek API key",
    dynamicModels: false,
    verified: false,
  },
];
const modelInfos: readonly ModelInfo[] = [{
  provider: "deepseek",
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  contextWindow: 8192,
  maxTokens: 2048,
}];
async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "laohuang-cli-test-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("empty session refresh replaces transcript then appends welcome", () => {
  const calls: string[] = [];
  const view: Pick<TerminalUI, "replaceTranscript" | "showWelcome"> = {
    replaceTranscript: (items) => {
      calls.push(`replace:${items.length}`);
    },
    showWelcome: () => {
      calls.push("welcome");
    },
  };

  resetEmptySessionTranscript(view);

  assert.deepEqual(calls, ["replace:0", "welcome"]);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test("session repl keeps prompting while the worker runs", async () => {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = new AgentSession(async (text: string) => {
    started.push(text);
    await gate;
    return "done";
  });

  class FakeUI {
    commandRegistry = null;
    inputs = ["first", "second", "/exit"];
    messages: string[] = [];
    showWelcome(): void {
      this.messages.push("welcome");
    }
    prompt(): string {
      const value = this.inputs.shift();
      if (value === undefined) {
        throw new PromptEofError();
      }
      if (value === "/exit") {
        release();
      }
      return value;
    }
    write(message: string): void {
      this.messages.push(message);
    }
    showError(message: string): void {
      this.messages.push(message);
    }
    showGoodbye(): void {
      this.messages.push("goodbye");
    }
    showInterrupted(): void {
      this.messages.push("interrupted");
    }
    stopEventRenderer(): void {}
  }

  const ui = new FakeUI();
  const presenter = new RecordingPresenter();
  session.eventBus.subscribe((event) => {
    if (event.kind === EventKind.UiMessage) {
      ui.messages.push(String((event.payload as { text?: unknown }).text ?? ""));
    }
  });

  await runSessionRepl(session, {
    ui,
    presenter,
    suggestCommand: () => null,
  });

  assert.equal(started[0], "first");
  assert.ok(presenter.notices.some((notice) =>
    notice.text.includes("Message queued")
  ));
  assert.ok(ui.messages.includes("goodbye"));
});

test("persistent terminal repl exits without leaving its queue blocked", async () => {
  class PersistentUI {
    commandRegistry = null;
    messages: string[] = [];
    exitRequests = 0;
    renderError: unknown = null;
    startEventRenderer(): void {}
    showWelcome(): void {
      this.messages.push("welcome");
    }
    async run(submit: (text: string) => void): Promise<void> {
      submit("/exit");
      await delay(50);
    }
    requestExit(): void {
      this.exitRequests += 1;
    }
    flushEventRenderer(): void {}
    stopEventRenderer(): void {}
    close(): void {
      this.messages.push("closed");
    }
    showGoodbye(): void {
      this.messages.push("goodbye");
    }
    showError(message: string): void {
      this.messages.push(message);
    }
  }

  const ui = new PersistentUI();
  const session = new AgentSession(() => "unused");

  assert.equal(await runSessionRepl(session, {
    ui,
    presenter: new RecordingPresenter(),
    suggestCommand: () => null,
  }), true);
  assert.equal(ui.exitRequests, 1);
  assert.ok(ui.messages.includes("closed"));
});

test("persistent repl sends two inputs then exits cleanly", async () => {
  class FakePiLoopUI {
    commandRegistry = null;
    renderError: unknown = null;
    closed = false;
    showWelcome(): void {}
    run(submit: (text: string) => void): void {
      for (const text of ["first", "second", "/exit"]) {
        submit(text);
      }
    }
    requestExit(): void {}
    flushEventRenderer(): void {}
    close(): void {
      this.closed = true;
    }
    showError(message: string): void {
      throw new Error(message);
    }
    showGoodbye(): void {}
  }

  const session = new AgentSession(async () => "done");
  const ui = new FakePiLoopUI();

  const clean = await runSessionRepl(session, {
    ui,
    presenter: new RecordingPresenter(),
    suggestCommand: () => null,
  });

  assert.equal(clean, true);
  assert.equal(ui.closed, true);
});

test("persistent repl returns false for terminal write failure", async () => {
  class FakePiLoopUI {
    commandRegistry = null;
    renderError: unknown = new Error("broken pipe");
    showWelcome(): void {}
    run(_submit: (text: string) => void): void {}
    flushEventRenderer(): void {}
    close(): void {}
    showGoodbye(): void {
      throw new Error("goodbye should not render on loop failure");
    }
    showError(_message: string): void {}
  }

  const session = new AgentSession(async () => "done");

  assert.equal(await runSessionRepl(session, {
    ui: new FakePiLoopUI(),
    presenter: new RecordingPresenter(),
    suggestCommand: () => null,
  }), false);
});

test("persistent exit reports slow prior routing failures through presenter", async () => {
  class FakeSession {
    closed = false;
    eventBus = { flush: async (): Promise<void> => {} };
    started: Promise<void>;
    release: Promise<void>;
    #startedResolve!: () => void;
    #releaseResolve!: () => void;
    state = "idle";

    constructor() {
      this.started = new Promise<void>((resolve) => {
        this.#startedResolve = resolve;
      });
      this.release = new Promise<void>((resolve) => {
        this.#releaseResolve = resolve;
      });
    }

    submitInput(text: string): Promise<unknown> {
      if (text === "slow") {
        this.#startedResolve();
        return (async () => {
          await this.release;
          if (this.closed) {
            throw new Error("event bus is closed");
          }
          return { taskId: "task-1", queued: false, rejected: false, reason: "" };
        })();
      }
      return Promise.resolve({
        taskId: "task-1",
        queued: false,
        rejected: false,
        reason: "",
      });
    }

    submitAction(action: { type: string; text?: string }): Promise<unknown> {
      if (action.type === "prompt" && action.text !== undefined) {
        return this.submitInput(action.text);
      }
      if (action.type === "exit") {
        return this.close();
      }
      return Promise.resolve(false);
    }

    close(): Promise<boolean> {
      this.closed = true;
      this.#releaseResolve();
      return Promise.resolve(true);
    }

    queueStatus(): { pending: number; held: number } {
      return { pending: 0, held: 0 };
    }

    publishNotice(): void {
      if (this.closed) {
        throw new Error("event bus is closed");
      }
    }
  }

  const session = new FakeSession();

  class FakePiLoopUI {
    commandRegistry = null;
    renderError: unknown = null;
    messages: string[] = [];
    async run(submit: (text: string) => void): Promise<void> {
      submit("slow");
      await session.started;
      submit("/exit");
    }
    showWelcome(): void {}
    requestExit(): void {}
    flushEventRenderer(): void {}
    close(): void {}
    showError(message: string): void {
      this.messages.push(message);
    }
  }

  const ui = new FakePiLoopUI();
  const presenter = new RecordingPresenter();
  const result = await runSessionRepl(
    session as unknown as SessionReplSession,
    { ui, presenter, suggestCommand: () => null },
  );

  assert.equal(result, true);
  assert.equal(session.closed, true);
  assert.deepEqual(ui.messages, []);
  assert.deepEqual(presenter.notices, [{
    text: "Error: event bus is closed",
    tone: "error",
  }]);
});

test("persistent repl reports unclean shutdown before ui close", async () => {
  const events: string[] = [];

  class FakeSession {
    eventBus = { flush: async (): Promise<void> => {} };
    close(): Promise<boolean> {
      return Promise.resolve(false);
    }
  }

  class FakePiLoopUI {
    commandRegistry = null;
    renderError: unknown = null;
    run(_submit: (text: string) => void): void {}
    showWelcome(): void {}
    close(): void {
      events.push("close");
    }
    showError(message: string): void {
      events.push(`error:${message}`);
    }
  }

  const presenter = new RecordingPresenter();
  const clean = await runSessionRepl(
    new FakeSession() as unknown as SessionReplSession,
    {
      ui: new FakePiLoopUI(),
      presenter,
      suggestCommand: () => null,
    },
  );

  assert.equal(clean, false);
  assert.deepEqual(events, ["close"]);
  assert.deepEqual(presenter.notices, [{
    text: "Task worker did not stop before the shutdown timeout.",
    tone: "error",
  }]);
});

test("plain repl uses agent session and waits for pipe eof", async () => {
  const calls: string[] = [];
  const answers = ["hello"];
  const outputs: string[] = [];
  const readInput = (_prompt: string): string => {
    const answer = answers.shift();
    if (answer === undefined) {
      throw new PromptEofError();
    }
    return answer;
  };
  const session = new AgentSession(async (content: string) => {
    calls.push(content);
    return "done";
  });
  const sink = new PlainEventSink((text) => {
    outputs.push(text);
  });
  const projector = new EventProjector();
  session.eventBus.subscribe((event) => {
    sink.publishEvent(projector.project(event, "terminal"));
  });

  await runPlainSessionRepl(session, {
    inputFn: readInput,
    presenter: new PlainCommandPresenter({
      output: (text) => outputs.push(text),
      input: async () => "",
      secretInput: async () => "",
    }),
    suggestCommand: () => null,
    sink,
  });

  assert.deepEqual(calls, ["hello"]);
  assert.ok(outputs.some((output) => output.includes("ready")));
  assert.equal(outputs.at(-1), "Goodbye.");
});

test("plain repl routes interruption through typed presenter notices", async () => {
  const presenter = new RecordingPresenter();
  const runtimeNotices: string[] = [];
  const session = new AgentSession(async () => "unused");
  session.eventBus.subscribe((event) => {
    if (event.kind === EventKind.UiMessage) {
      runtimeNotices.push(String((event.payload as { text?: unknown }).text ?? ""));
    }
  });
  let interrupted = false;

  await runPlainSessionRepl(session, {
    inputFn: () => {
      if (!interrupted) {
        interrupted = true;
        throw new PromptCancelledError();
      }
      return "/exit";
    },
    presenter,
    suggestCommand: () => null,
    sink: new PlainEventSink(() => {}),
  });

  assert.deepEqual(presenter.notices, [
    {
      text: "laoHuangCode is ready. Type /help for commands or /exit to quit.",
      tone: "info",
    },
    { text: "Interrupted. Type /exit to quit.", tone: "warning" },
  ]);
  assert.deepEqual(runtimeNotices, []);
});

test("plain repl routes shutdown failures through typed presenter notices", async () => {
  const presenter = new RecordingPresenter();
  const output: string[] = [];
  const session = {
    state: "idle",
    eventBus: { flush: async () => {} },
    submitInput: async () => ({ queued: false, rejected: false }),
    submitAction: async () => false,
    promotePendingToSteer: () => 0,
    queueStatus: () => ({}),
    publishNotice: () => {},
    waitForIdle: async () => true,
    close: async () => false,
  } as unknown as SessionReplSession;

  const clean = await runPlainSessionRepl(session, {
    inputFn: () => "/exit",
    presenter,
    suggestCommand: () => null,
    sink: new PlainEventSink((text) => output.push(text)),
  });

  assert.equal(clean, false);
  assert.deepEqual(presenter.notices.at(-1), {
    text: "Task worker did not stop before the shutdown timeout.",
    tone: "error",
  });
  assert.equal(output.includes("Error: Task worker did not stop before the shutdown timeout."), false);
});

test("plain repl receives unknown-command suggestions without terminal UI", async () => {
  const presenter = new RecordingPresenter();
  const session = new AgentSession(async () => "unused");
  const inputs = ["/hep", "/exit"];

  await runPlainSessionRepl(session, {
    commandHandler: async () => ({ status: "not_found", command: "/hep" }),
    inputFn: () => inputs.shift() ?? "/exit",
    presenter,
    suggestCommand: () => "/help",
    sink: new PlainEventSink(() => {}),
  });

  assert.ok(presenter.notices.some((notice) =>
    notice.text === "Unknown command: /hep. Did you mean /help?" &&
    notice.tone === "info"
  ));
});

test("session repl routes submitted text through neutral session actions", async () => {
  const actions: string[] = [];
  const session = new AgentSession(async () => "done");
  const originalSubmitAction = session.submitAction.bind(session);
  session.submitAction = async (action) => {
    actions.push(action.type);
    return originalSubmitAction(action);
  };

  class FakeUI {
    commandRegistry = null;
    inputs = ["hello", "/exit"];
    prompt(): string {
      const value = this.inputs.shift();
      if (value === undefined) {
        throw new PromptEofError();
      }
      return value;
    }
    showWelcome(): void {}
    showGoodbye(): void {}
    showError(): void {}
    stopEventRenderer(): void {}
  }

  await runSessionRepl(session, {
    ui: new FakeUI(),
    presenter: new RecordingPresenter(),
    suggestCommand: () => null,
  });

  assert.deepEqual(actions, ["prompt"]);
});

test("session repl reports malformed slash input without exiting", async () => {
  const presenter = new RecordingPresenter();
  const session = new AgentSession(async () => "unused");

  class FakeUI {
    commandRegistry = null;
    inputs = ['/model "unterminated', "/exit"];
    prompt(): string {
      const value = this.inputs.shift();
      if (value === undefined) {
        throw new PromptEofError();
      }
      return value;
    }
    showWelcome(): void {}
    showGoodbye(): void {}
    showError(): void {}
    stopEventRenderer(): void {}
  }

  await runSessionRepl(session, {
    ui: new FakeUI(),
    presenter,
    suggestCommand: () => null,
  });

  assert.ok(presenter.notices.some((notice) =>
    notice.text.includes("No closing quotation")
  ));
});

test("persistent repl preserves follow-up submit metadata", async () => {
  const actions: Array<{ type: string; text?: string }> = [];
  const session = new AgentSession(async () => null);
  const originalSubmitAction = session.submitAction.bind(session);
  session.submitAction = async (action) => {
    actions.push({ type: action.type, text: "text" in action ? action.text : undefined });
    return originalSubmitAction(action);
  };

  class FakePiLoopUI {
    commandRegistry = null;
    renderError: unknown = null;
    run(submit: (text: string, options?: { strategy?: "follow_up" | "steer" }) => void): void {
      submit("later", { strategy: "follow_up" });
      submit("/exit");
    }
    showWelcome(): void {}
    requestExit(): void {}
    flushEventRenderer(): void {}
    close(): void {}
    showGoodbye(): void {}
    showError(message: string): void {
      throw new Error(message);
    }
  }

  await runSessionRepl(session, {
    ui: new FakePiLoopUI(),
    presenter: new RecordingPresenter(),
    suggestCommand: () => null,
  });

  assert.deepEqual(actions, [{ type: "follow_up", text: "later" }]);
});

test("terminal ui is only enabled for the real interactive streams", () => {
  const tty = { isTTY: true };
  const pipe = { isTTY: false };

  assert.equal(supportsTerminalUI({ stdin: tty, stdout: tty }), true);
  assert.equal(
    supportsTerminalUI({ inputFn: () => "", stdin: tty, stdout: tty }),
    false,
  );
  assert.equal(supportsTerminalUI({ stdin: pipe, stdout: tty }), false);
});

test("parseArgs accepts provider identifiers without a built-in catalog", () => {
  const parsed = parseArgs([
    "config",
    "--provider",
    "missing",
    "--model",
    "model-1",
  ]);

  assert.equal(parsed.kind, "run");
  if (parsed.kind === "run") {
    assert.equal(parsed.args.provider, "missing");
  }
});

test("startup model selection uses the plain presenter and shared selector service", async () => {
  const catalog = new FakeCatalog(providerInfos);
  catalog.models.set("deepseek", modelInfos);
  const auth = new FakeProviderAuth(new Set(["deepseek"]));
  const selector = new ModelSelector({ catalog, providerAuth: auth });
  const answers = ["1", "1"];
  const output: string[] = [];
  const presenter = new PlainCommandPresenter({
    output: (text) => output.push(text),
    input: async () => answers.shift() ?? "",
    secretInput: async () => "unused-secret",
  });

  const selection = await runInitialModelSelection({ selector, presenter, providerAuth: auth });

  assert.equal(selection?.config.provider, "deepseek");
  assert.equal(selection?.config.model, "deepseek-v4-flash");
  assert.deepEqual(auth.ensureConfiguredCalls, [
    { provider: "deepseek", promptIfMissing: true, hasPrompts: true },
    { provider: "deepseek", promptIfMissing: true, hasPrompts: true },
  ]);
  assert.ok(output.includes("Select model provider"));
});

test("user can chat until exit", async () => {
  const inputs = ["hello", "/exit"];
  const outputs: string[] = [];
  const agentInputs: string[] = [];
  const agent = {
    run(text: string): string {
      agentInputs.push(text);
      return "hi there";
    },
  };

  await runRepl(agent, {
    inputFn: () => inputs.shift()!,
    outputFn: (message) => {
      outputs.push(message);
    },
  });

  assert.deepEqual(agentInputs, ["hello"]);
  assert.ok(outputs.some((output) => output.includes("hi there")));
});

test("repl can drive a structured terminal ui", async () => {
  class FakeUI {
    inputs = ["hello", "/exit"];
    events: unknown[] = [];
    showWelcome(): void {
      this.events.push("welcome");
    }
    prompt(): string {
      return this.inputs.shift()!;
    }
    thinking(): { close(): void } {
      return { close(): void {} };
    }
    showAssistant(response: string): void {
      this.events.push(["assistant", response]);
    }
    showGoodbye(): void {
      this.events.push("goodbye");
    }
    showInterrupted(): void {}
    showError(): void {}
    write(): void {}
  }

  const ui = new FakeUI();
  const agent = { run: async (_text: string): Promise<string> => "hi there" };

  await runRepl(agent, { ui });

  assert.deepEqual(ui.events, ["welcome", ["assistant", "hi there"], "goodbye"]);
});

test("first start collects provider key and model in the terminal", async () => {
  await withTempDir(async (directory) => {
    const configPath = join(directory, "config.json");
    const credentialsPath = join(directory, "credentials.json");
    const answers = ["7", "1", "/exit"];
    const outputs: string[] = [];

    const status = await cliMain([], {
      environ: {},
      configPath,
      credentialsPath,
      inputFn: () => answers.shift()!,
      secretInputFn: () => "terminal-secret",
      outputFn: (message) => {
        outputs.push(message);
      },
    });

    assert.equal(status, 0);
    assert.deepEqual(await new CredentialStore(credentialsPath).read("deepseek"), {
      type: "api_key",
      key: "terminal-secret",
    });
    assert.ok(!outputs.join("\n").includes("terminal-secret"));
    assert.equal(
      new ConfigManager(configPath).listProfiles()[0]!.model,
      "deepseek-v4-flash",
    );
  });
});

test("config command saves a provider profile without starting agent", async () => {
  await withTempDir(async (directory) => {
    const configPath = join(directory, "config.json");
    const credentialsPath = join(directory, "credentials.json");
    const answers = ["1"];
    const outputs: string[] = [];

    const status = await cliMain(
      ["config", "--profile", "work", "--provider", "deepseek"],
      {
        environ: {},
        configPath,
        credentialsPath,
        inputFn: () => answers.shift()!,
        secretInputFn: () => "terminal-key",
        outputFn: (message) => {
          outputs.push(message);
        },
      },
    );

    assert.equal(status, 0);
    assert.ok(existsSync(configPath));
    assert.deepEqual(await new CredentialStore(credentialsPath).read("deepseek"), {
      type: "api_key",
      key: "terminal-key",
    });
    assert.ok(outputs.some((output) => output.includes("work")));
  });
});

test("config command cancels an invalid interactive provider choice", async () => {
  await withTempDir(async (directory) => {
    const outputs: string[] = [];
    const status = await cliMain(["config"], {
      environ: {},
      configPath: join(directory, "config.json"),
      inputFn: () => "999",
      secretInputFn: () => {
        throw new Error("no key expected");
      },
      outputFn: (message) => {
        outputs.push(message);
      },
    });

    assert.equal(status, 2);
    assert.ok(outputs.some((line) => line.includes("Select model provider")));
  });
});

test("configured deepseek profile starts interactive cli", async () => {
  await withTempDir(async (directory) => {
    const configPath = join(directory, "config.json");
    const credentialsPath = join(directory, "credentials.json");
    new ConfigManager(configPath).configure({
      name: "deepseek",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
    });
    const outputs: string[] = [];

    const status = await cliMain([], {
      environ: {},
      configPath,
      credentialsPath,
      inputFn: () => "/exit",
      secretInputFn: () => "terminal-key",
      outputFn: (message) => {
        outputs.push(message);
      },
    });

    assert.equal(status, 0);
    assert.deepEqual(await new CredentialStore(credentialsPath).read("deepseek"), {
      type: "api_key",
      key: "terminal-key",
    });
    assert.ok(
      outputs.some((output) => output.includes("laoHuangCode is ready")),
    );
  });
});

test("user can list profiles and switch the active one", async () => {
  await withTempDir(async (directory) => {
    const configPath = join(directory, "config.json");
    const manager = new ConfigManager(configPath);
    manager.configure({
      name: "flash",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
    });
    manager.configure({
      name: "pro",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      baseUrl: "https://api.deepseek.com",
    });
    const outputs: string[] = [];
    const outputFn = (message: string): void => {
      outputs.push(message);
    };

    const useStatus = await cliMain(["config", "use", "flash"], {
      environ: {},
      configPath,
      outputFn,
    });
    const listStatus = await cliMain(["config", "list"], {
      environ: {},
      configPath,
      outputFn,
    });

    assert.deepEqual([useStatus, listStatus], [0, 0]);
    assert.ok(outputs.some((output) => output.includes("* flash")));
    assert.ok(outputs.some((output) => output.includes("deepseek-v4-pro")));
  });
});

test("doctor reports resolved runtime configuration", async () => {
  await withTempDir(async (directory) => {
    const configPath = join(directory, "config.json");
    const credentialsPath = join(directory, "credentials.json");
    new ConfigManager(configPath).configure({
      name: "deepseek",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
    });
    await new CredentialStore(credentialsPath).modify("deepseek", async () => ({
      type: "api_key",
      key: "secret",
    }));
    const outputs: string[] = [];

    const status = await cliMain(["doctor"], {
      environ: {},
      configPath,
      credentialsPath,
      outputFn: (message) => {
        outputs.push(message);
      },
    });

    assert.equal(status, 0);
    const report = outputs.join("\n");
    assert.ok(report.includes("Provider: deepseek"));
    assert.ok(report.includes("Model: deepseek-v4-flash"));
    assert.ok(report.includes("API key: configured"));
  });
});

test("version flag works without model configuration", () => {
  const completed = spawnSync(process.execPath, [CLI_PATH, "--version"], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(completed.stdout.trim(), `laohuang ${VERSION}`);
});
