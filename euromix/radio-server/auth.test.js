import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyEuromixToken } from "./auth.js";

const SECRET = "test-secret-for-euromix-radio-only-which-is-long-enough";

function issue(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  return data + "." + sig;
}

test("accepts a valid Euromix bearer token", () => {
  const token = issue({ tg: "123456789", aud: "euromix", exp: 2000000000 });
  assert.deepEqual(verifyEuromixToken(token, SECRET, 1900000000), { telegramId: "123456789" });
});

test("rejects expired tokens", () => {
  const token = issue({ tg: "123456789", aud: "euromix", exp: 1899999999 });
  assert.equal(verifyEuromixToken(token, SECRET, 1900000000), null);
});

test("rejects tokens for another audience", () => {
  const token = issue({ tg: "123456789", aud: "other-app", exp: 2000000000 });
  assert.equal(verifyEuromixToken(token, SECRET, 1900000000), null);
});

test("rejects altered signatures and malformed payloads", () => {
  const token = issue({ tg: "123456789", aud: "euromix", exp: 2000000000 });
  const changed = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  assert.equal(verifyEuromixToken(changed, SECRET, 1900000000), null);
  assert.equal(verifyEuromixToken("not-a-token", SECRET), null);
});

test("rejects invalid Telegram identifiers", () => {
  const token = issue({ tg: "admin", aud: "euromix", exp: 2000000000 });
  assert.equal(verifyEuromixToken(token, SECRET, 1900000000), null);
});
