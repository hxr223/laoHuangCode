/** Construct the OpenAI-compatible SDK client from resolved configuration. */

import OpenAI from "openai";

import type { Config } from "./config.ts";

/**
 * Minimal structural view of the runtime configuration needed here.
 * The full `Config` type is owned by config.ts and is assignable to this
 * shape (checked by the assertion below), so `createClient` can be called
 * directly with a resolved `Config`.
 */
export interface ClientConfig {
  apiKey?: string | null | undefined;
  baseUrl?: string | null | undefined;
}

// Compile-time guarantee: config.ts's Config stays assignable to ClientConfig.
type AssertConfigAssignable = Config extends ClientConfig ? true : never;
const assertConfigAssignable: AssertConfigAssignable = true;
void assertConfigAssignable;

/** Options handed to the SDK client factory (openai npm naming). */
export interface ClientConnectionSettings {
  apiKey: string;
  baseURL?: string;
}

export interface CreateClientOptions<T> {
  clientFactory?: ((settings: ClientConnectionSettings) => T) | undefined;
}

export function createClient<T = OpenAI>(
  config: ClientConfig,
  options: CreateClientOptions<T> = {},
): T {
  if (!config.apiKey) {
    throw new Error("API key is required to create a model client");
  }
  const clientFactory =
    options.clientFactory ??
    ((settings: ClientConnectionSettings) => new OpenAI(settings) as T);

  const settings: ClientConnectionSettings = { apiKey: config.apiKey };
  if (config.baseUrl) {
    settings.baseURL = config.baseUrl;
  }
  return clientFactory(settings);
}
