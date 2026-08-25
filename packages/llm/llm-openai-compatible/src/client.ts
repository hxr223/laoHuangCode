/** Construct the OpenAI-compatible SDK client from resolved configuration. */

import OpenAI from "openai";

/**
 * Minimal structural view of the runtime configuration needed here.
 */
export interface ClientConfig {
  apiKey?: string | null | undefined;
  baseUrl?: string | null | undefined;
}

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
