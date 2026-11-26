import http from "node:http";
import { Readable } from "node:stream";
import { Pool } from "pg";
import { verifyEuromixToken } from "./auth.js";
import { safeMediaPath, decodeMediaFile } from "./media.js";
import { toAzuraStationPath } from "./azura-path.js";

const PORT = Number(process.env.PORT || 8787);
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const DATABASE_URL = process.env.DATABASE_URL || "";
const AZURACAST_API_URL = (process.env.EUROMIX_AZURACAST_API_URL || "").replace(/\/+$/, "");
const AZURACAST_API_KEY = process.env.AZURACAST_API_KEY || "";
const STATION_ID = String(process.env.EUROMIX_AZURACAST_STATION_ID || "");
const STATION_SHORTCODE = process.env.EUROMIX_AZURACAST_STATION_SHORTCODE || "euromix";
const ALLOWED_ORIGIN = process.env.EUROMIX_ALLOWED_ORIGIN || "https://www.nettlegroup.space";
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 18 * 1024 * 1024);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error("PORT is invalid");
if (!SESSION_SECRET || SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!AZURACAST_API_URL || !AZURACAST_API_KEY || !/^\d+$/.test(STATION_ID)) {
  throw new Error("AzuraCast API URL, API key and numeric station ID are required");
}
const apiUrl = new URL(AZURACAST_API_URL);
if (apiUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(apiUrl.hostname)) {
  throw new Error("AzuraCast API must use HTTPS");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: "euromix-radio-control"
});

const json = (res, status, data, extraHeaders = {}) => {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders
  });
  res.end(body);
};

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && origin !== ALLOWED_ORIGIN) {
    json(res, 403, { error: "origin_not_allowed" });
    return false;
  }
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader("access-control-allow-origin", ALLOWED_ORIGIN);
    res.setHeader("vary", "Origin");
    res.setHeader("access-control-allow-headers", "Authorization, Content-Type, Accept");
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  }
  return true;
}

async function adminTelegramId(req) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  if (!match) return null;
  const identity = verifyEuromixToken(match[1], SESSION_SECRET);
  if (!identity) return null;

  const result = await pool.query(
    "SELECT is_admin FROM public.user_profiles WHERE telegram_id = $1 LIMIT 1",
    [identity.telegramId]
  );
  return result.rows[0]?.is_admin === true ? identity.telegramId : null;
}

async function fetchAzura(path, options = {}) {
  const url = new URL(path.replace(/^\/+/, ""), AZURACAST_API_URL + "/");
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      authorization: "Bearer " + AZURACAST_API_KEY,
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(options.body ? 10 * 60_000 : 20_000)
  });
  return response;
}



async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("request_too_large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_json");
    return value;
  } catch {
    const error = new Error("invalid_json");
    error.statusCode = 400;
    throw error;
  }
}

async function uploadMedia(req, res) {
  const contentType = String(req.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    return json(res, 415, { error: "application_json_required" });
  }
  const maxEncodedBytes = Math.ceil(MAX_UPLOAD_BYTES * 4 / 3) + 32_768;
  const input = await readJsonBody(req, maxEncodedBytes);
  const path = safeMediaPath(input.path);
  if (!path) return json(res, 400, { error: "invalid_media_path" });

  const encoded = input.file;
  const bytes = decodeMediaFile(encoded, MAX_UPLOAD_BYTES);
  if (!bytes) return json(res, 400, { error: "invalid_media_data_or_size", maxBytes: MAX_UPLOAD_BYTES });

  const result = await fetchAzura("station/" + STATION_ID + "/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, file: encoded })
  });
  const body = await result.text();
  res.writeHead(result.status, {
    "content-type": result.headers.get("content-type") || "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

async function proxyAdminRequest(req, res, pathname, search) {
  const relativePath = toAzuraStationPath(pathname, STATION_ID);
  if (!relativePath) return json(res, 404, { error: "route_not_found" });

  const method = req.method || "GET";
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return json(res, 405, { error: "method_not_allowed" });
  }

  const contentType = String(req.headers["content-type"] || "");
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    return json(res, 413, { error: "upload_too_large", maxBytes: MAX_UPLOAD_BYTES });
  }

  const headers = {};
  if (contentType) headers["content-type"] = contentType;
  if (req.headers.accept) headers.accept = String(req.headers.accept);

  const init = { method, headers };
  if (!["GET", "HEAD"].includes(method)) {
    init.body = req;
    init.duplex = "half";
  }

  const upstream = await fetchAzura(relativePath + search, init);
  res.writeHead(upstream.status, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...(upstream.headers.get("content-type") ? { "content-type": upstream.headers.get("content-type") } : {}),
    ...(upstream.headers.get("content-length") ? { "content-length": upstream.headers.get("content-length") } : {})
  });
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!applyCors(req, res)) return;
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "cache-control": "no-store" });
      return res.end();
    }

    const requestUrl = new URL(req.url || "/", "http://localhost");
    const pathname = requestUrl.pathname;

    if (req.method === "GET" && pathname === "/health") {
      await pool.query("SELECT 1");
      return json(res, 200, { ok: true, service: "euromix-radio-control" });
    }

    if (req.method === "GET" && pathname === "/api/now-playing") {
      const result = await fetchAzura("nowplaying/" + encodeURIComponent(STATION_SHORTCODE), {
        headers: { accept: "application/json" }
      });
      const body = await result.text();
      res.writeHead(result.status, {
        "content-type": result.headers.get("content-type") || "application/json",
        "cache-control": "public, max-age=3, stale-while-revalidate=5",
        "x-content-type-options": "nosniff"
      });
      return res.end(body);
    }

    if (pathname.startsWith("/api/admin/")) {
      const telegramId = await adminTelegramId(req);
      if (!telegramId) return json(res, 403, { error: "admin_access_required" });

      if (req.method === "GET" && pathname === "/api/admin/station") {
        const result = await fetchAzura("station/" + STATION_ID);
        const body = await result.text();
        res.writeHead(result.status, {
          "content-type": result.headers.get("content-type") || "application/json",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff"
        });
        return res.end(body);
      }

      // Friendly routes for the Euromix admin UI. The station ID is kept
      // server-side and callers cannot select another AzuraCast station.
      if (req.method === "GET" && pathname === "/api/admin/files") {
        return await proxyAdminRequest(req, res, "/api/admin/azuracast/station/" + STATION_ID + "/files", requestUrl.search);
      }
      if (req.method === "GET" && pathname === "/api/admin/playlists") {
        return await proxyAdminRequest(req, res, "/api/admin/azuracast/station/" + STATION_ID + "/playlists", requestUrl.search);
      }
      if (req.method === "POST" && pathname === "/api/admin/upload") {
        return await uploadMedia(req, res);
      }
      const mediaParts = pathname.split("/");
      if (
        (mediaParts.length === 5 || mediaParts.length === 6) &&
        mediaParts[1] === "api" &&
        mediaParts[2] === "admin" &&
        ["files", "playlists"].includes(mediaParts[3]) &&
        /^[0-9]+$/.test(mediaParts[4]) &&
        (mediaParts.length === 5 || mediaParts[5] === "play")
      ) {
        const resource = mediaParts[3];
        const id = mediaParts[4];
        const action = mediaParts[5] || "";
        const path = "/api/admin/azuracast/station/" + STATION_ID + "/" + resource + "/" + id + (action ? "/" + action : "");
        return await proxyAdminRequest(req, res, path, requestUrl.search);
      }

      return await proxyAdminRequest(req, res, pathname, requestUrl.search);
    }

    return json(res, 404, { error: "route_not_found" });
  } catch (error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (error?.statusCode === 400 || error?.statusCode === 413) {
      return json(res, error.statusCode, { error: error.message });
    }
    const unavailable = error?.name === "TimeoutError" || error?.name === "AbortError";
    json(res, unavailable ? 504 : 502, {
      error: unavailable ? "radio_engine_timeout" : "radio_engine_unavailable"
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  process.stdout.write("Euromix radio-control listening on port " + PORT + "\n");
});

async function shutdown() {
  server.close();
  await pool.end().catch(() => {});
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
