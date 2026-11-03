import { dirname, join, resolve } from "node:path";
import type { AttachmentContent, AttachmentStore, ImageRef } from "@laohuang/attachment";
import { projectCodeModeStore, type SessionEntry } from "@laohuang/session-store";
import { createCodeModeTool, createCodeModeImagePort, CodeModeWorkerPool, type ManagedCodeModeTool } from "@laohuang/tool-codemode";
import type { SessionController } from "./session-controller.ts";

export interface CodeModeRuntime {
  readonly tool: ManagedCodeModeTool;
  resolveReference(id: string): ImageRef | undefined;
  close(): Promise<void>;
}

/** One CLI-owned pool and tool serve every branch; each execution binds its own history. */
export function createCodeModeRuntime(options: {
  configPath: string;
  attachments: AttachmentStore;
  sessionController: SessionController;
  workerUrl?: string | URL;
}): CodeModeRuntime {
  const pool = new CodeModeWorkerPool();
  const tool = createCodeModeTool({ workerPool: pool,
    workerUrl: options.workerUrl ?? new URL(import.meta.url.endsWith(".ts") ? "./codemode-worker.ts" : "./codemode-worker.js", import.meta.url),
    bindSession: context => {
      const history = options.sessionController.history;
      const journal = options.sessionController.currentJournal;
      const sessionId = options.sessionController.currentSessionId;
      if (!history || !journal || !sessionId || journal.closed || context.sessionId && context.sessionId !== sessionId) throw new Error("Code Mode session is unavailable or has changed");
      return {
        readStore: () => {
          if (journal.closed) throw new Error("Code Mode owning session has closed");
          return projectCodeModeStore(history.entries());
        },
        images: createCodeModeImagePort({ store: options.attachments, references: sessionAttachments(history.entries()) }),
        outputDirectory: join(dirname(resolve(options.configPath)), "codemode-artifacts", sessionId),
      };
    },
  });
  return {
    tool,
    resolveReference: id => sessionAttachments(options.sessionController.history?.entries() ?? [])
      .find((block): block is Extract<AttachmentContent, { type: "image" }> => block.type === "image" && block.ref.id === id)?.ref,
    async close() { pool.close(); await tool.close(); },
  };
}

function sessionAttachments(entries: readonly SessionEntry[]): AttachmentContent[] {
  const result: AttachmentContent[] = [];
  for (const entry of entries) {
    if (entry.entryType === "tool_result") result.push(...entry.payload.codeMode?.internalAttachments ?? []);
    if ("message" in entry.payload && "attachments" in entry.payload.message) result.push(...entry.payload.message.attachments ?? []);
  }
  return result;
}
