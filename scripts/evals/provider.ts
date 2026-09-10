import type { ApiProvider, CallApiContextParams, CallApiOptionsParams, ProviderOptions, ProviderResponse } from "promptfoo";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OUTPUT_ROOT } from "./build.ts";
import { runScenario } from "./sandbox.ts";
import { createTargetScenario, toProviderResponse } from "./target.ts";
import { listFixtureFiles, safeFixturePath } from "./verifier.ts";
import type { RunOptions } from "./types.ts";

export default class LaohuangProvider implements ApiProvider {
  readonly #options: RunOptions;
  readonly #controllers = new Set<AbortController>();
  constructor(options: ProviderOptions = {}) {
    const config = options.config as RunOptions | undefined;
    if (config?.mode !== "live" && config?.mode !== "offline") throw new Error("Evaluation mode must be explicit");
    this.#options = config;
  }
  id(): string { return "laohuang:official:kimi-coding"; }
  async callApi(prompt: string, _context?: CallApiContextParams, options?: CallApiOptionsParams): Promise<ProviderResponse> {
    if (this.#options.outputRoot && existsSync(join(this.#options.outputRoot, "cancelled"))) return { error: "Evaluation batch cancelled" };
    const files = JSON.parse(readFileSync(join(OUTPUT_ROOT, "image/project.json"), "utf8")) as Record<string, string>;
    const scenario = createTargetScenario(prompt, files);
    const controller = new AbortController();
    this.#controllers.add(controller);
    try {
      const evidence = await runScenario(scenario, { ...this.#options,
        signal: options?.abortSignal ? AbortSignal.any([controller.signal, options.abortSignal]) : controller.signal });
      const changed: Record<string, string | null> = {};
      if (evidence.artifacts) {
        const root = join(evidence.artifacts, "files");
        for (const name of listFixtureFiles(root)) {
          const value = readFileSync(safeFixturePath(root, name), "utf8");
          if (files[name] !== value) changed[name] = value;
        }
        for (const name of Object.keys(files)) if (!existsSync(safeFixturePath(root, name))) changed[name] = null;
      }
      // Refuse incomplete snapshots rather than presenting partial artifacts to the judge.
      if (evidence.checks.some((c) => c.name === "artifact-integrity" && !c.pass)) {
        evidence.status = "error"; evidence.error = "Artifact snapshot incomplete";
      }
      return toProviderResponse(evidence, changed);
    } finally { this.#controllers.delete(controller); }
  }
  cleanup(): void { for (const controller of this.#controllers) controller.abort(); }
}
