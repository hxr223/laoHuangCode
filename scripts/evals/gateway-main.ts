import { createInterface } from "node:readline";
import { createGateway, type GatewayOptions } from "./gateway.ts";
const lines = createInterface({ input: process.stdin });
lines.once("line", (line) => {
  const config = JSON.parse(line) as Omit<
    GatewayOptions,
    "upstream" | "onRecord"
  >;
  if (!config.apiKey || !config.token || config.maxRequests < 1)
    throw new Error("Invalid gateway configuration");
  const server = createGateway({
    ...config,
    onRecord: (record) => process.stdout.write(JSON.stringify(record) + "\n"),
  });
  server.listen(8080, "0.0.0.0", () =>
    process.stdout.write('{"kind":"ready"}\n'),
  );
});
