import { ModelError } from "@laohuang/llm";
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

export interface ApiKeyCredential {
  readonly type: "api_key";
  readonly key?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ApiKeyCredentialInfo {
  readonly providerId: string;
  readonly type: "api_key";
}

export interface ApiKeyCredentialStoreLike {
  read(providerId: string): Promise<ApiKeyCredential | undefined>;
  list(): Promise<readonly ApiKeyCredentialInfo[]>;
  modify(
    providerId: string,
    fn: (
      current: ApiKeyCredential | undefined,
    ) => Promise<ApiKeyCredential | undefined>,
  ): Promise<ApiKeyCredential | undefined>;
  delete(providerId: string): Promise<void>;
}

export class PiCredentialStore implements CredentialStore {
  private readonly store: ApiKeyCredentialStoreLike;

  constructor(store: ApiKeyCredentialStoreLike) {
    this.store = store;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.store.read(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.store.list();
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.store.modify(providerId, async (current) => {
      const next = await fn(current);
      if (next === undefined) {
        return undefined;
      }
      if (next.type !== "api_key") {
        throw new ModelError("OAuth credentials are not supported", {
          kind: "protocol",
        });
      }
      return next;
    });
  }

  async delete(providerId: string): Promise<void> {
    await this.store.delete(providerId);
  }
}
