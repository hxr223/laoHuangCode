import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { startMcpFixture } from "./mcp-fixture.ts";

export async function startOAuthFixture(options: { rejectRegistration?: boolean; wrongIssuer?: boolean; rejectAuthorization?: boolean; transport?: "http" | "sse" } = {}) {
  let origin = "";
  let access = "not-issued";
  let refresh = "not-issued";
  let challenge = "";
  let registrations = 0;
  let exchanges = 0;
  let refreshes = 0;
  let observedScope = "";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", origin);
    const json = (value: unknown, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname.startsWith("/.well-known/")) {
      json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], authorization_response_iss_parameter_supported: true,
        scopes_supported: ["tools", "offline_access"] }); return;
    }
    if (url.pathname === "/authorize") {
      challenge = url.searchParams.get("code_challenge") ?? "";
      observedScope = url.searchParams.get("scope") ?? "";
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("state", url.searchParams.get("state")!);
      redirect.searchParams.set("iss", options.wrongIssuer ? "http://wrong.invalid" : origin);
      redirect.searchParams.set(options.rejectAuthorization ? "error" : "code", options.rejectAuthorization ? "access_denied" : "fixture-code");
      res.writeHead(302, { location: redirect.toString() }).end(); return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    if (url.pathname === "/register") {
      registrations++;
      if (options.rejectRegistration) { json({ error: "invalid_client_metadata" }, 400); return; }
      json({ ...JSON.parse(body), client_id: "fixture-client" }, 201); return;
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") {
        refreshes++;
        if (params.get("refresh_token") !== refresh) { json({ error: "invalid_grant" }, 400); return; }
      } else {
        exchanges++;
        if (params.get("code") !== "fixture-code" || createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") !== challenge) {
          json({ error: "invalid_grant" }, 400); return;
        }
      }
      access = `fixture-access-${exchanges}-${refreshes}`;
      refresh = `fixture-refresh-${exchanges}-${refreshes}`;
      json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600 }); return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("OAuth fixture failed to listen");
  origin = `http://127.0.0.1:${address.port}`;
  const mcp = await startMcpFixture({ protocol: options.transport === "sse" ? "legacy" : "modern", transport: options.transport ?? "http", oauth: { issuer: origin, token: () => access } });
  return {
    config: { ...mcp.config, auth: { type: "oauth" as const } }, origin,
    expireAccess() { access = "expired"; },
    counts: () => ({ registrations, exchanges, refreshes }),
    scope: () => observedScope,
    async close() { await mcp.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); },
  };
}
