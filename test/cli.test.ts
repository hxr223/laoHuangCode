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
  runPlainSessionRepl,
  runRepl,
  runSessionRepl,
  supportsTerminalUI,
  terminalUiPrompts,
  type SessionReplSession,
} from "../src/cli.ts";
import { ConfigManager } from "../src/config.ts";
import { CredentialStore } from "../src/credentials.ts";
import { EventKind, EventProjector } from "../src/events.ts";
import { ModelSelector } from "../src/model-selection.ts";
import { createClient } from "../src/client.ts";
import { getProvider, providerNames } from "../src/providers.ts";
import { AgentSession } from "../src/session.ts";
import { PromptEofError } from "../src/terminal/input.ts";
import { MemoryTerminalDriver } from "../src/terminal/screen.ts";
import { PlainEventSink, TerminalUI } from "../src/terminal/ui.ts";

const textEncoder = new TextEncoder();

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function withTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "laohuang-cli-test-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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
  session.eventBus.subscribe((event) => {
    if (event.kind === EventKind.UiMessage) {
      ui.messages.push(String((event.payload as { text?: unknown }).text ?? ""));
    }
  });

  await runSessionRepl(session, { ui });

  assert.equal(started[0], "first");
  assert.ok(ui.messages.some((item) => item.includes("Message queued")));
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

  assert.equal(await runSessionRepl(session, { ui }), true);
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

  const clean = await runSessionRepl(session, { ui });

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

  assert.equal(await runSessionRepl(session, { ui: new FakePiLoopUI() }), false);
});

test("persistent exit does not wait for slow prior routing", async () => {
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
  const result = await runSessionRepl(
    session as unknown as SessionReplSession,
    { ui },
  );

  assert.equal(result, false);
  assert.equal(session.closed, true);
  assert.deepEqual(ui.messages, ["Input coordinator failed during shutdown."]);
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

  const clean = await runSessionRepl(
    new FakeSession() as unknown as SessionReplSession,
    { ui: new FakePiLoopUI() },
  );

  assert.equal(clean, false);
  assert.deepEqual(events, [
    "error:Task worker did not stop before the shutdown timeout.",
    "close",
  ]);
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

  await runPlainSessionRepl(session, { inputFn: readInput, sink });

  assert.deepEqual(calls, ["hello"]);
  assert.ok(outputs.some((output) => output.includes("ready")));
  assert.equal(outputs.at(-1), "Goodbye.");
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

  await runSessionRepl(session, { ui: new FakeUI() });

  assert.deepEqual(actions, ["prompt"]);
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
    run(submit: (text: string, options?: { strategy?: "follow_up" }) => void): void {
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

  await runSessionRepl(session, { ui: new FakePiLoopUI() });

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

test("tty wiring asks model selection through the running terminal ui", async () => {
  // Regression: inside a running TUI session the selector's questions must
  // come from the injected TerminalUI prompts (which coordinate with the
  // interactive loop), never from a blocking read of fd 0.
  const terminal = new MemoryTerminalDriver({ columns: 80, rows: 24 });
  const ui = new TerminalUI({ driver: terminal });
  ui.startLoop(() => {});
  const prompts = terminalUiPrompts(ui);
  const store = new Map<string, string>();
  const selector = new ModelSelector({
    credentials: {
      get: (provider) => store.get(provider) ?? null,
      set: (provider, apiKey) => {
        store.set(provider, apiKey);
      },
    },
    registry: { get: getProvider, names: providerNames },
    createClient,
    input: prompts.input,
    secretInput: prompts.secretInput,
    output: () => {},
    clientFactory: () => ({}),
  });

  const pending = selector.select({ providerName: "deepseek" });
  try {
    // The secret question is rendered by the terminal UI itself.
    for (let index = 0; index < 20; index += 1) {
      ui.drainLoop();
      if (terminal.writes().includes("Enter deepseek API key:")) {
        break;
      }
      await delay(1);
    }
    assert.ok(terminal.writes().includes("Enter deepseek API key:"));

    ui.feedInputBytes(textEncoder.encode("tty-key\r"));
    ui.drainLoop();
    // Wait until the selector advances to the model question.
    for (let index = 0; index < 20; index += 1) {
      await delay(1);
      ui.drainLoop();
      if (terminal.writes().includes("Select model:")) {
        break;
      }
    }
    assert.ok(terminal.writes().includes("Select model:"));

    ui.feedInputBytes(textEncoder.encode("1\r"));
    ui.drainLoop();

    const selection = await pending;
    assert.ok(selection);
    assert.equal(selection.config.apiKey, "tty-key");
    assert.equal(
      selection.config.model,
      getProvider("deepseek").suggestedModels[0],
    );
    assert.equal(store.get("deepseek"), "tty-key");
    // The key was typed into the masked UI prompt, never echoed back.
    assert.ok(!terminal.writes().includes("tty-key"));
  } finally {
    ui.close();
  }
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
    const answers = ["1", "1", "/exit"];
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
      clientFactory: () => ({}),
    });

    assert.equal(status, 0);
    assert.equal(
      new CredentialStore(credentialsPath).get("deepseek"),
      "terminal-secret",
    );
    assert.ok(!outputs.join("\n").includes("terminal-secret"));
    assert.equal(
      new ConfigManager(configPath).listProfiles()[0]!.model,
      "deepseek-v4-flash",
    );
  });
});

test("web flag starts dashboard and cleanly exits", async () => {
  await withTempDir(async (directory) => {
    const configPath = join(directory, "config.json");
    new ConfigManager(configPath).configure({
      name: "default",
      provider: "deepseek",
    });
    new CredentialStore(join(directory, "credentials.json")).set(
      "deepseek",
      "test-key",
    );

    const completed = spawnSync(
      process.execPath,
      [CLI_PATH, "--web", "--web-port", "0"],
      {
        cwd: PROJECT_ROOT,
        env: { ...process.env, LAOHUANG_CONFIG: configPath },
        input: "/exit\n",
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    assert.equal(completed.status, 0, completed.stderr);
    assert.ok(completed.stdout.includes("Web dashboard: http://127.0.0.1:"));
  });
});

test("config command saves a provider profile without starting agent", async () => {
  await withTempDir(async (directory) => {
    const configPath = join(directory, "config.json");
    const credentialsPath = join(directory, "credentials.json");
    const outputs: string[] = [];

    const status = await cliMain(
      ["config", "--profile", "work", "--provider", "deepseek"],
      {
        environ: {},
        configPath,
        credentialsPath,
        inputFn: () => "1",
        secretInputFn: () => "terminal-key",
        outputFn: (message) => {
          outputs.push(message);
        },
        clientFactory: () => ({}),
      },
    );

    assert.equal(status, 0);
    assert.ok(existsSync(configPath));
    assert.equal(
      new CredentialStore(credentialsPath).get("deepseek"),
      "terminal-key",
    );
    assert.ok(outputs.some((output) => output.includes("work")));
  });
});

test("config command reports invalid interactive provider", async () => {
  await withTempDir(async (directory) => {
    const outputs: string[] = [];
    const status = await cliMain(["config"], {
      environ: {},
      configPath: join(directory, "config.json"),
      inputFn: () => "invalid-provider",
      secretInputFn: () => {
        throw new Error("no key expected");
      },
      outputFn: (message) => {
        outputs.push(message);
      },
    });

    assert.equal(status, 2);
    assert.ok(outputs.some((line) => line.includes("invalid provider")));
  });
});

test("configured deepseek profile starts interactive cli", async () => {
  await withTempDir(async (directory) => {
    const configPath = join(directory, "config.json");
    const credentialsPath = join(directory, "credentials.json");
    new ConfigManager(configPath).configure({
      name: "deepseek",
      provider: "deepseek",
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
      clientFactory: () => ({}),
    });

    assert.equal(status, 0);
    assert.equal(
      new CredentialStore(credentialsPath).get("deepseek"),
      "terminal-key",
    );
    assert.ok(
      outputs.some((output) => output.includes("laoHuangCode is ready")),
    );
  });
});

test("user can list profiles and switch the active one", async () => {
  await withTempDir(async (directory) => {
    const configPath = join(directory, "config.json");
    const manager = new ConfigManager(configPath);
    manager.configure({ name: "flash", provider: "deepseek" });
    manager.configure({
      name: "pro",
      provider: "deepseek",
      model: "deepseek-v4-pro",
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
    });
    new CredentialStore(credentialsPath).set("deepseek", "secret");
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
