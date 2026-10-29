import handler from "./api-handler.cjs";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers.entries());
    let body;

    if (!["GET", "HEAD"].includes(request.method)) {
      const raw = await request.text();
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          const responseHeaders = new Headers({
            "content-type": "application/json; charset=utf-8",
          });
          const origin = request.headers.get("origin");
          if (origin && origin === process.env.SITE_ORIGIN) {
            responseHeaders.set("access-control-allow-origin", origin);
            responseHeaders.set("access-control-allow-credentials", "true");
            responseHeaders.set("vary", "Origin");
          }
          return new Response(JSON.stringify({ error: "bad_json" }), {
            status: 400,
            headers: responseHeaders,
          });
        }
      }
    }

    const req = { method: request.method, url: request.url, headers, body };
    const responseHeaders = new Headers();
    let status = 200;
    let output = "";

    const res = {
      setHeader(name, value) {
        responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
      },
      getHeader(name) {
        return responseHeaders.get(name);
      },
      end(value = "") {
        output = value == null ? "" : String(value);
      },
    };

    Object.defineProperty(res, "statusCode", {
      get() {
        return status;
      },
      set(value) {
        status = value;
      },
    });

    try {
      await handler(req, res, url.pathname);
      if (!responseHeaders.has("content-type")) {
        responseHeaders.set("content-type", "application/json; charset=utf-8");
      }

      // Node's Fetch Response forbids a body for 204, 304 and HEAD responses.
      const responseBody =
        status === 204 || status === 304 || request.method === "HEAD" ? null : output;

      return new Response(responseBody, { status, headers: responseHeaders });
    } catch (error) {
      console.error("Nettle API error", error);
      const origin = request.headers.get("origin");
      const errorHeaders = new Headers({
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      if (origin && origin === process.env.SITE_ORIGIN) {
        errorHeaders.set("access-control-allow-origin", origin);
        errorHeaders.set("access-control-allow-credentials", "true");
        errorHeaders.set("vary", "Origin");
      }
      return new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: errorHeaders,
      });
    }
  },
};
