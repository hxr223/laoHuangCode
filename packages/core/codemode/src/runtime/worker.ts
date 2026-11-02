import { parentPort, workerData } from "node:worker_threads";
import { isHostToWorkerMessage, type WorkerData } from "./protocol.ts";
import { startVm } from "./vm.ts";

export async function runCodeModeWorker(): Promise<void> {
  if (!parentPort) throw new Error("Code Mode worker requires a parent port");
  const port = parentPort;
  const data = workerData as WorkerData;
  const interrupt = new Int32Array(data.interrupt);
  try {
    const session = await startVm({ data, wasm: data.wasm, post: message => port.postMessage(message),
      shouldInterrupt: () => Atomics.load(interrupt, 0) !== 0 });
    port.on("message", (message: unknown) => {
      if (isHostToWorkerMessage(message)) session.deliver(message);
      else port.postMessage({ type: "crash", message: "Invalid host protocol message" });
    });
    port.on("close", () => session.dispose());
  } catch (error) { port.postMessage({ type: "crash", message: error instanceof Error ? error.message : String(error) }); }
}
