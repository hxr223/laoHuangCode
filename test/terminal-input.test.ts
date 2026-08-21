import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";

import {
  PiInputSession,
  PromptCancelledError,
  PromptEofError,
  type PiInputSessionOptions,
} from "../src/terminal/input.ts";

interface FakeIO {
  input: PassThrough;
  output: Writable & { columns?: number };
  written: () => string;
}

function createSession(options: Partial<PiInputSessionOptions> = {}): {
  session: PiInputSession;
  io: FakeIO;
} {
  const input = new PassThrough();
  const chunks: Buffer[] = [];
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk as Buffer);
        callback();
      },
    }),
    { columns: 40 as number | undefined },
  );
  const session = new PiInputSession({ input, output, ...options });
  return {
    session,
    io: { input, output, written: () => Buffer.concat(chunks).toString("utf8") },
  };
}

function type(io: FakeIO, data: string): void {
  io.input.write(Buffer.from(data, "utf8"));
}

test("enter submits the typed line", async () => {
  const { session, io } = createSession();
  const result = session.prompt();

  type(io, "hello");
  type(io, "\r");

  assert.equal(await result, "hello");
  assert.ok(io.written().includes("❯ hello"));
});

test("alt+enter inserts a newline instead of submitting", async () => {
  const { session, io } = createSession();
  const result = session.prompt();

  type(io, "one\x1b\rtwo\r");

  assert.equal(await result, "one\ntwo");
});

test("enter submits immediately when multiline is disabled", async () => {
  const { session, io } = createSession({ multiline: false });
  const result = session.prompt();

  type(io, "one\x1b\rtwo\r");

  // Alt+Enter is ignored without multiline, so the text is "onetwo".
  assert.equal(await result, "onetwo");
});

test("up recalls history and the submission is appended in place", async () => {
  const history = ["prev"];
  const { session, io } = createSession({ history });
  const result = session.prompt();

  type(io, "\x1b[A\r");

  assert.equal(await result, "prev");
  assert.deepEqual(history, ["prev", "prev"]);
});

test("ctrl+c rejects with PromptCancelledError", async () => {
  const { session, io } = createSession();
  const result = session.prompt();

  type(io, "draft\x03");

  await assert.rejects(result, PromptCancelledError);
});

test("ctrl+d on an empty editor rejects with PromptEofError", async () => {
  const { session, io } = createSession();
  const result = session.prompt();

  type(io, "\x04");

  await assert.rejects(result, PromptEofError);
});

test("ctrl+d with text does not exit", async () => {
  const { session, io } = createSession();
  const result = session.prompt();

  type(io, "x\x04\x7f\r");

  assert.equal(await result, "");
});

test("tab accepts the first slash completion", async () => {
  const { session, io } = createSession({
    completer: (text) =>
      text === "/e" ? [{ value: "/exit", description: "退出程序", start: -2 }] : [],
  });
  const result = session.prompt();

  type(io, "/e\t\r");

  assert.equal(await result, "/exit");
});

test("enter accepts a visible slash completion and submits", async () => {
  const { session, io } = createSession({
    completer: (text) =>
      text === "/"
        ? [
            { value: "/exit", description: "退出", start: -1 },
            { value: "/help", description: "帮助", start: -1 },
          ]
        : [],
  });
  const result = session.prompt();

  type(io, "/");
  type(io, "\r");
  type(io, "\r");

  assert.equal(await result, "/exit");
  assert.ok(io.written().includes("\x1b[7m"));
});

test("bracketed paste inserts newlines instead of submitting", async () => {
  const { session, io } = createSession();
  const result = session.prompt();

  type(io, "\x1b[200~one\ntwo\x1b[201~\r");

  assert.equal(await result, "one\ntwo");
});

test("masked input renders stars instead of the secret", async () => {
  const { session, io } = createSession({ mask: true });
  const result = session.prompt();

  type(io, "pw");
  type(io, "\r");

  assert.equal(await result, "pw");
  assert.ok(io.written().includes("❯ **"));
  assert.ok(!io.written().includes("❯ pw"));
});

test("the frame is erased when the prompt finishes", async () => {
  const { session, io } = createSession();
  const result = session.prompt();

  type(io, "hi\r");
  await result;

  const output = io.written();
  assert.ok(output.includes("─"));
  assert.ok(output.endsWith("\r\x1b[0J"));
});

test("the frame stays on screen when eraseWhenDone is false", async () => {
  const { session, io } = createSession({ eraseWhenDone: false });
  const result = session.prompt();

  type(io, "hi\r");
  await result;

  assert.ok(io.written().endsWith("\r\n"));
});

test("footer lines render below the frame", async () => {
  const { session, io } = createSession({ footer: () => "project: demo" });
  const result = session.prompt();

  type(io, "\r");

  assert.equal(await result, "");
  assert.ok(io.written().includes("project: demo"));
});
