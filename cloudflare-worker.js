export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const cors = corsHeaders(origin, allowedOrigin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, cors);
    }

    if (!isAllowedOrigin(origin, allowedOrigin)) {
      return json({ error: "Origin not allowed" }, 403, cors);
    }

    if (env.ACCESS_TOKEN) {
      const token = request.headers.get("X-Bubble-Token") || "";
      if (token !== env.ACCESS_TOKEN) {
        return json({ error: "Unauthorized" }, 401, cors);
      }
    }

    if (!env.DEEPSEEK_API_KEY) {
      return json({ error: "Missing DEEPSEEK_API_KEY secret" }, 500, cors);
    }

    const body = await request.text();
    const upstream = await fetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`
      },
      body
    });

    const headers = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(cors)) {
      headers.set(key, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers
    });
  }
};

function isAllowedOrigin(origin, allowedOrigin) {
  if (allowedOrigin === "*") return true;
  if (!origin) return false;
  return allowedOrigin.split(",").map(item => item.trim()).filter(Boolean).includes(origin);
}

function corsHeaders(origin, allowedOrigin) {
  const allowOrigin = isAllowedOrigin(origin, allowedOrigin) ? (allowedOrigin === "*" ? "*" : origin) : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Bubble-Token",
    "Vary": "Origin"
  };
}

function json(data, status = 200, headers = corsHeaders("", "*")) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...headers
    }
  });
}
