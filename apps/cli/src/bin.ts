import { main } from "./main.ts";

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`laohuang: ${message}\n`);
    process.exitCode = 1;
  },
);
