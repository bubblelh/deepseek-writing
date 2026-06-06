export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";
    const cors = corsHeaders(origin, allowedOrigin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
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

    if (url.pathname === "/sync") {
      return handleSync(request, env, cors);
    }

    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, cors);
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

async function handleSync(request, env, cors) {
  if (!env.DB) {
    return json({ error: "Missing D1 binding DB" }, 500, cors);
  }

  await ensureSyncSchema(env);

  const userId = env.SYNC_USER || "bubblelh";

  if (request.method === "GET") {
    const result = await readSyncState(env, userId);
    return json(result, 200, cors);
  }

  if (request.method === "POST") {
    const payload = await request.json();
    const updatedAt = Date.now();
    await writeSyncState(env, userId, payload.data || payload, updatedAt);
    return json({ ok: true, updatedAt, storage: "tables" }, 200, cors);
  }

  return json({ error: "Method not allowed" }, 405, cors);
}

async function ensureSyncSchema(env) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS app_state (
      user_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sync_meta (
      user_id TEXT PRIMARY KEY,
      current_id TEXT,
      settings TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 3
    )`,
    `CREATE TABLE IF NOT EXISTS conversations (
      user_id TEXT NOT NULL,
      id TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      sync_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      sync_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, conversation_id, message_index)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_user_order ON conversations (user_id, order_index)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_convo_order ON messages (user_id, conversation_id, message_index)`
  ];

  for (const statement of statements) {
    await env.DB.prepare(statement).run();
  }
}

async function readSyncState(env, userId) {
  const meta = await env.DB.prepare("SELECT current_id, settings, updated_at FROM sync_meta WHERE user_id = ?")
    .bind(userId)
    .first();

  if (!meta) {
    const legacy = await env.DB.prepare("SELECT data, updated_at FROM app_state WHERE user_id = ?")
      .bind(userId)
      .first();
    return legacy ? { data: JSON.parse(legacy.data), updatedAt: legacy.updated_at, storage: "legacy" } : { data: null, updatedAt: 0, storage: "tables" };
  }

  const convoRows = await env.DB.prepare("SELECT id, data FROM conversations WHERE user_id = ? ORDER BY order_index ASC")
    .bind(userId)
    .all();
  const messageRows = await env.DB.prepare("SELECT conversation_id, data FROM messages WHERE user_id = ? ORDER BY conversation_id ASC, message_index ASC")
    .bind(userId)
    .all();

  const messagesByConvo = new Map();
  for (const row of messageRows.results || []) {
    if (!messagesByConvo.has(row.conversation_id)) messagesByConvo.set(row.conversation_id, []);
    messagesByConvo.get(row.conversation_id).push(JSON.parse(row.data));
  }

  const conversations = (convoRows.results || []).map(row => {
    const convo = JSON.parse(row.data);
    convo.messages = messagesByConvo.get(row.id) || [];
    return convo;
  });

  return {
    data: {
      version: 3,
      conversations,
      currentId: meta.current_id || "",
      settings: JSON.parse(meta.settings || "{}"),
      updatedAt: meta.updated_at
    },
    updatedAt: meta.updated_at,
    storage: "tables"
  };
}

async function writeSyncState(env, userId, data, updatedAt) {
  const syncId = updatedAt;
  const conversations = Array.isArray(data.conversations) ? data.conversations : [];
  const settings = data.settings || {};

  await env.DB.prepare(`
    INSERT INTO sync_meta (user_id, current_id, settings, updated_at, version)
    VALUES (?, ?, ?, ?, 3)
    ON CONFLICT(user_id) DO UPDATE SET
      current_id = excluded.current_id,
      settings = excluded.settings,
      updated_at = excluded.updated_at,
      version = excluded.version
  `).bind(userId, data.currentId || "", JSON.stringify(settings), updatedAt).run();

  const convoStatement = env.DB.prepare(`
    INSERT INTO conversations (user_id, id, order_index, data, updated_at, sync_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      order_index = excluded.order_index,
      data = excluded.data,
      updated_at = excluded.updated_at,
      sync_id = excluded.sync_id
  `);
  const messageStatement = env.DB.prepare(`
    INSERT INTO messages (user_id, conversation_id, message_index, data, updated_at, sync_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, conversation_id, message_index) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at,
      sync_id = excluded.sync_id
  `);

  const batches = [];
  conversations.forEach((convo, convoIndex) => {
    const messages = Array.isArray(convo.messages) ? convo.messages : [];
    const convoData = { ...convo, messages: [] };
    const convoUpdatedAt = Number(convo.updatedAt) || updatedAt;
    batches.push(convoStatement.bind(userId, convo.id || `convo-${convoIndex}`, convoIndex, JSON.stringify(convoData), convoUpdatedAt, syncId));
    messages.forEach((message, messageIndex) => {
      batches.push(messageStatement.bind(userId, convo.id || `convo-${convoIndex}`, messageIndex, JSON.stringify(message), convoUpdatedAt, syncId));
    });
  });

  await runBatches(env, batches);
  await env.DB.prepare("DELETE FROM messages WHERE user_id = ? AND sync_id != ?").bind(userId, syncId).run();
  await env.DB.prepare("DELETE FROM conversations WHERE user_id = ? AND sync_id != ?").bind(userId, syncId).run();
}

async function runBatches(env, statements, size = 80) {
  for (let index = 0; index < statements.length; index += size) {
    await env.DB.batch(statements.slice(index, index + size));
  }
}

function isAllowedOrigin(origin, allowedOrigin) {
  if (allowedOrigin === "*") return true;
  if (!origin) return false;
  return allowedOrigin.split(",").map(item => item.trim()).filter(Boolean).includes(origin);
}

function corsHeaders(origin, allowedOrigin) {
  const allowOrigin = isAllowedOrigin(origin, allowedOrigin) ? (allowedOrigin === "*" ? "*" : origin) : "null";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
