import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("Fixture requires a worker parent");
for (const message of JSON.parse(workerData.code)) parentPort.postMessage(message);
