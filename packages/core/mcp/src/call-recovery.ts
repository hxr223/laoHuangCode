import { ProtocolError, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";

export function connectionClosed(error: unknown): boolean {
  return error instanceof SdkError && (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected);
}

export function recoverableConnectionError(error: unknown): boolean {
  if (connectionClosed(error)) return true;
  if (error instanceof SdkError) return error.code === SdkErrorCode.SendFailed;
  if (!(error instanceof Error) || error instanceof ProtocolError || error.name === "AbortError" || error.name === "ZodError") return false;
  const code = (error as Error & { code?: unknown }).code;
  return ["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"].includes(String(code))
    || error instanceof TypeError && /fetch failed|network/i.test(error.message);
}

/** Kimi-style bounded replay. Output adaptation is intentionally outside this function. */
export async function callWithRecovery<T, C>(options: {
  client: C;
  check(): void;
  call(client: C): Promise<T>;
  ping(client: C): Promise<void>;
  reconnect(stale: C): Promise<C>;
  update?(): void;
}): Promise<T> {
  options.check();
  let failure: unknown;
  try { return await options.call(options.client); } catch (error) { failure = error; }
  options.check();
  if (!recoverableConnectionError(failure)) throw failure;
  if (!connectionClosed(failure)) {
    let alive = false;
    try { await options.ping(options.client); alive = true; }
    catch (error) { alive = error instanceof ProtocolError || error instanceof SdkError && error.code === SdkErrorCode.InvalidResult; }
    options.check();
    if (alive) {
      try { return await options.call(options.client); }
      catch (error) {
        options.check();
        if (!recoverableConnectionError(error)) throw error;
      }
    }
  }
  options.update?.();
  const client = await options.reconnect(options.client);
  options.check();
  return options.call(client);
}
