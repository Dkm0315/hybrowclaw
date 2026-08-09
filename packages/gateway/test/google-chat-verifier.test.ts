import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createGoogleChatRequestVerifier, gatewayStartupErrors, googleChatAudienceIsValid } from "../src/index.js";

const NOW_MS = Date.parse("2026-07-10T10:00:00.000Z");
const AUDIENCE = "https://agent.example.test/v1/adapters/gchat";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

function token(payload: Record<string, unknown>, kid = "key-1"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid, typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    aud: AUDIENCE,
    iss: "https://accounts.google.com",
    email: "chat@system.gserviceaccount.com",
    email_verified: true,
    iat: Math.floor(NOW_MS / 1000) - 10,
    exp: Math.floor(NOW_MS / 1000) + 600,
    ...overrides,
  };
}

test("Google Chat verifier validates OIDC and project JWTs and caches certificates", async () => {
  let fetches = 0;
  const fetcher = (async () => {
    fetches += 1;
    return new Response(JSON.stringify({ "key-1": publicPem }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    });
  }) as typeof fetch;
  const verifier = createGoogleChatRequestVerifier({ fetcher, now: () => NOW_MS });
  const verify = (jwt: string) => verifier.verify({ authorization: `Bearer ${jwt}`, rawBody: "{}", payload: {}, audience: AUDIENCE });

  assert.equal(await verify(token(basePayload())), true);
  assert.equal(await verify(token(basePayload())), true);
  assert.equal(fetches, 1, "warm verification should not refetch certificates");

  assert.equal(await verify(token(basePayload({ iss: "chat@system.gserviceaccount.com", email: undefined, email_verified: undefined }))), true);
  assert.equal(fetches, 2, "project JWTs use the Chat service-account certificate endpoint");
});

test("Google Chat verifier fails closed for audience, issuer, identity, expiry, tamper, and cert errors", async () => {
  const fetcher = (async () => new Response(JSON.stringify({ "key-1": publicPem }), { status: 200 })) as typeof fetch;
  const verifier = createGoogleChatRequestVerifier({ fetcher, now: () => NOW_MS, clockSkewSeconds: 0 });
  const verify = (jwt: string, authorization = `Bearer ${jwt}`) => verifier.verify({ authorization, rawBody: "{}", payload: {}, audience: AUDIENCE });

  assert.equal(await verify(token(basePayload({ aud: "https://wrong.example" }))), false);
  assert.equal(await verify(token(basePayload({ iss: "attacker@example.test" }))), false);
  assert.equal(await verify(token(basePayload({ email: "attacker@example.test" }))), false);
  assert.equal(await verify(token(basePayload({ exp: Math.floor(NOW_MS / 1000) - 1 }))), false);
  const valid = token(basePayload());
  const parts = valid.split(".");
  const tamperedSignature = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
  assert.equal(await verify(`${parts[0]}.${parts[1]}.${tamperedSignature}`), false);
  assert.equal(await verify(valid, valid), false, "a bare token is not an Authorization bearer header");

  const unavailable = createGoogleChatRequestVerifier({
    fetcher: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
    now: () => NOW_MS,
  });
  assert.equal(await unavailable.verify({ authorization: `Bearer ${valid}`, rawBody: "{}", payload: {}, audience: AUDIENCE }), false);
});

test("Google Chat audience readiness accepts only signed endpoint or project-number forms", () => {
  assert.equal(googleChatAudienceIsValid(AUDIENCE), true);
  assert.equal(googleChatAudienceIsValid("123456789012"), true);
  for (const invalid of [
    "",
    "chat-app-123",
    "123",
    "http://agent.example.test/v1/adapters/gchat",
    "https://agent.example.test/gchat",
    "https://user:secret@agent.example.test/v1/adapters/gchat",
    "https://agent.example.test/v1/adapters/gchat?token=secret",
    "https://agent.example.test/v1/adapters/gchat#fragment",
  ]) assert.equal(googleChatAudienceIsValid(invalid), false, invalid);

  const production = (audience: string) => gatewayStartupErrors({
    token: "a".repeat(32),
    security: { deployment: "production" },
    gchat: { verification: { mode: "bearer", audience } },
  });
  assert.deepEqual(production(AUDIENCE), []);
  assert.deepEqual(production("123456789012"), []);
  assert.ok(production("not-an-audience").some((error) => error.includes("Google Chat")));
});
