import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { OUTPUT_ROOT, REPO_ROOT, prepareEvaluation, requirePreparedImage } from "./build.ts";
import { CODING_PLUGINS, createEvaluationConfig } from "./config.ts";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  "num-tests": { type: "string" }, timeout: { type: "string" }, batch: { type: "string" },
} });
const command = positionals[0];
const pointer = join(OUTPUT_ROOT, "official-current");
async function promptfoo(args: string[], directory: string): Promise<void> {
  const child = spawn(process.execPath, [join(REPO_ROOT, "node_modules/promptfoo/dist/src/entrypoint.js"), ...args], {
    cwd: REPO_ROOT, stdio: "inherit", env: { ...process.env,
      PROMPTFOO_DISABLE_SHARING: "1", PROMPTFOO_DISABLE_TELEMETRY: "1" },
  });
  const cancel = (): void => {
    writeFileSync(join(directory, "cancelled"), "cancelled\n");
    child.kill("SIGINT");
  };
  process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1));
    });
    if (code !== 0) throw new Error(`promptfoo exited with ${code}; see its diagnostics above`);
  } finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
}
if (command === "prepare") {
  console.log(await prepareEvaluation());
} else if (command === "list") {
  console.log(CODING_PLUGINS.join("\n"));
} else if (command === "config") {
  requirePreparedImage();
  const count = Number(values["num-tests"] ?? 10);
  const timeoutMs = Number(values.timeout ?? 180) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error("Timeout must be at least one second");
  const directory = join(OUTPUT_ROOT, "official", randomUUID());
  const provider = readFileSync(join(OUTPUT_ROOT, "image/provider-path"), "utf8");
  const config = createEvaluationConfig({ mode: "live", outputRoot: directory, timeoutMs }, count,
    provider, join(dirname(provider), "judge.mjs"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, "config.yaml"), JSON.stringify(config, null, 2));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({
    createdAt: new Date().toISOString(), suite: "promptfoo official coding-agent plugins",
    plugins: CODING_PLUGINS, requestedTestsPerPlugin: count,
    targetModel: "kimi-coding/kimi-for-coding", judgeModel: "kimi-coding/kimi-for-coding",
    promptfooVersion: "0.122.2", sourceFingerprint: readFileSync(join(OUTPUT_ROOT, "image/source-fingerprint"), "utf8"),
    generation: "promptfoo remote coding-agent generator", strategies: ["basic"],
  }, null, 2));
  writeFileSync(pointer, directory);
  console.log(`官方插件配置（尚未生成题目、未调用模型）：${join(directory, "config.yaml")}\n下一步：npm run eval:generate`);
} else if (command === "generate" || command === "run") {
  requirePreparedImage();
  const directory = values.batch ?? (existsSync(pointer) ? readFileSync(pointer, "utf8") : "");
  if (!directory) throw new Error("Run npm run eval:config first");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as { sourceFingerprint: string };
  if (manifest.sourceFingerprint !== readFileSync(join(OUTPUT_ROOT, "image/source-fingerprint"), "utf8"))
    throw new Error("Official batch is stale; create a new config and generate its tests");
  if (existsSync(join(directory, "cancelled"))) throw new Error("This batch was cancelled; create a new batch");
  const generated = join(directory, "redteam.yaml");
  if (command === "generate") {
    if (existsSync(generated)) throw new Error("Generated questions already exist; create a new config to preserve provenance");
    console.log("Generating official questions using promptfoo remote service. The configured application description is sent to that service.");
    const pending = join(directory, "redteam.pending.yaml");
    await promptfoo(["redteam", "generate", "-c", join(directory, "config.yaml"), "-o", pending,
      "--strict", "--no-cache", "--max-concurrency", "1"], directory);
    renameSync(pending, generated);
    console.log(`官方题目和断言：${generated}\n可在 http://localhost:15500/setup 导入此文件后运行，也可 npm run eval:all。`);
  } else {
    if (!existsSync(generated)) throw new Error("No official questions yet; run npm run eval:generate first");
    await promptfoo(["eval", "-c", generated, "--no-cache", "--no-share", "--max-concurrency", "1",
      "-o", join(directory, `results-${randomUUID()}.json`)], directory);
    console.log("官方评分结果已写入 promptfoo；在 http://localhost:15500/history 查看。");
  }
} else {
  throw new Error("Usage: node scripts/evals/cli.ts prepare|config|generate|run|list [--num-tests 10] [--timeout 180] [--batch path]");
}
