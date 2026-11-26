import crypto from "node:crypto";

const TELEGRAM_ID_PATTERN = /^\d{1,20}$/;

/**
 * Verifies the exact two-part HMAC token format issued by NettleGroup's
 * existing Euromix mobile sign-in flow. The token grants identity only;
 * administrator status is always read fresh from user_profiles.
 */
export function verifyEuromixToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== "string" || !secret || secret.length < 32) return null;

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  try {
    const expected = crypto.createHmac("sha256", secret).update(parts[0]).digest();
    const actual = Buffer.from(parts[1], "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    if (payload.aud !== "euromix") return null;
    if (!Number.isInteger(payload.exp) || payload.exp <= nowSeconds) return null;

    const telegramId = String(payload.tg ?? "");
    if (!TELEGRAM_ID_PATTERN.test(telegramId)) return null;

    return { telegramId };
  } catch {
    return null;
  }
}
