import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
const GUESTY_API = "https://open-api.guesty.com/v1";
const TOKEN_URL = "https://open-api.guesty.com/oauth2/token";

// ── Auth ──────────────────────────────────────────────────────────────────────
// Token persisted in env so it survives Render cold starts
// GUESTY_CACHED_TOKEN and GUESTY_TOKEN_EXPIRY are set at runtime (in-memory across requests)
let cachedToken = process.env.GUESTY_CACHED_TOKEN || null;
let tokenExpiry = parseInt(process.env.GUESTY_TOKEN_EXPIRY || "0");

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  // Enforce minimum 60s between auth calls to avoid 429
  const now = Date.now();
  const lastAuthAttempt = parseInt(global._lastAuthAttempt || 0);
  if (now - lastAuthAttempt < 60000) {
    // Too soon — reuse stale token if we have one rather than hammering auth
    if (cachedToken) {
      console.log("getToken: throttled, reusing existing token");
      return cachedToken;
    }
    const wait = 60000 - (now - lastAuthAttempt);
    console.log(`getToken: throttled, waiting ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
  }
  global._lastAuthAttempt = Date.now();

  let res;
  try {
    const params = new URLSearchParams();
    params.append("grant_type", "client_credentials");
    params.append("scope", "open-api");
    params.append("client_id", process.env.GUESTY_CLIENT_ID);
    params.append("client_secret", process.env.GUESTY_CLIENT_SECRET);
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (e) {
    console.error("getToken fetch error:", e.message, e.cause?.message || "", e.cause?.code || "");
    throw e;
  }
  if (!res.ok) {
    const body = await res.text();
    console.error("getToken HTTP error:", res.status, body);
    throw new Error(`Auth failed ${res.status}: ${body}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    console.error("getToken: no access_token in response:", JSON.stringify(data));
    throw new Error("No access_token in auth response");
  }
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  console.log("getToken: NEW token obtained, expires in", data.expires_in, "s");
  return cachedToken;
}

// ── Request Queue (rate limit protection) ────────────────────────────────────
// Guesty allows ~15 req/sec. We serialize all calls with 150ms spacing.
const requestQueue = [];
let queueRunning = false;

async function enqueue(fn) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ fn, resolve, reject });
    if (!queueRunning) drainQueue();
  });
}

async function drainQueue() {
  queueRunning = true;
  while (requestQueue.length > 0) {
    const { fn, resolve, reject } = requestQueue.shift();
    try {
      const result = await fn();
      resolve(result);
    } catch (e) {
      reject(e);
    }
    if (requestQueue.length > 0) {
      await new Promise(r => setTimeout(r, 600)); // 600ms between calls (~100 req/min, under 120/min limit)
    }
  }
  queueRunning = false;
}


// ── API helper with retry ─────────────────────────────────────────────────────
async function guestyRequest(method, path, params = {}, body = null, retries = 3) {
  return enqueue(() => _guestyRequest(method, path, params, body, retries));
}

async function _guestyRequest(method, path, params = {}, body = null, retries = 3) {
  const token = await getToken();
  let url = `${GUESTY_API}${path}`;
  if (method === "GET" && Object.keys(params).length) {
    url += "?" + new URLSearchParams(params).toString();
  }
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      const wait = attempt * 2000;
      console.log(`Rate limited. Retry ${attempt}/${retries} in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(`Guesty ${res.status}: ${JSON.stringify(data)}`);
    return data;
  }
  throw new Error("Max retries exceeded");
}

// ── Conversation Cache ────────────────────────────────────────────────────────
// Maps reservation_id → conversation_id
const conversationCache = new Map();
let cacheReady = false;
let cacheError = null;
let cacheBuilding = false;

function indexConversation(convo) {
  const reservations = convo.meta?.reservations || [];
  reservations.forEach(r => {
    if (r._id) conversationCache.set(r._id, convo._id);
  });
}

async function buildCache() {
  if (cacheBuilding) return;
  cacheBuilding = true;
  try {
    console.log("Building conversation cache...");
    const list = await guestyRequest("GET", "/communication/conversations", { limit: 100 });
    const conversations = list.data?.conversations || list.conversations || [];
    conversations.forEach(indexConversation);
    cacheReady = true;
    cacheBuilding = false;
    cacheError = null;
    console.log(`Cache built: ${conversationCache.size} entries from ${conversations.length} conversations`);
  } catch (e) {
    cacheError = e.message;
    cacheBuilding = false;
    console.error("Cache build failed:", e.message);
  }
}

// Cache is built lazily on first tool use (no startup hammering)

// ── Find conversation ID for a reservation ────────────────────────────────────
async function findConversationId(reservation_id) {
  // 1. Check in-memory cache first (instant)
  if (conversationCache.has(reservation_id)) {
    return conversationCache.get(reservation_id);
  }

  // Lazy cache build: if cache has never been populated, build it now
  if (!cacheReady && !cacheBuilding) {
    await buildCache();
    if (conversationCache.has(reservation_id)) {
      return conversationCache.get(reservation_id);
    }
  }

  // 2. Fetch the reservation — check for embedded conversationId
  try {
    const res = await guestyRequest("GET", `/reservations/${reservation_id}`, {
      fields: "conversationId guestId listingId"
    });
    
    // Some Guesty accounts embed the conversationId directly on the reservation
    if (res.conversationId) {
      conversationCache.set(reservation_id, res.conversationId);
      return res.conversationId;
    }

    // Try filtering conversations by guestId
    if (res.guestId) {
      try {
        const byGuest = await guestyRequest("GET", "/communication/conversations", {
          limit: 20,
          guestId: res.guestId
        });
        const convos = byGuest.data?.conversations || byGuest.conversations || [];
        convos.forEach(indexConversation);
        if (conversationCache.has(reservation_id)) {
          return conversationCache.get(reservation_id);
        }
      } catch (e) { /* guestId filter may not be supported */ }
    }

    // Try filtering conversations by listingId
    if (res.listingId) {
      try {
        const byListing = await guestyRequest("GET", "/communication/conversations", {
          limit: 100,
          listingId: res.listingId
        });
        const convos = byListing.data?.conversations || byListing.conversations || [];
        convos.forEach(indexConversation);
        if (conversationCache.has(reservation_id)) {
          return conversationCache.get(reservation_id);
        }
      } catch (e) { /* listingId filter may not be supported */ }
    }
  } catch (e) {
    console.log("Reservation lookup error:", e.message);
  }

  // 3. Fallback: scan top 100 most recent conversations
  try {
    const list = await guestyRequest("GET", "/communication/conversations", { limit: 100 });
    const convos = list.data?.conversations || list.conversations || [];
    convos.forEach(indexConversation);
    if (conversationCache.has(reservation_id)) {
      return conversationCache.get(reservation_id);
    }
  } catch (e) {
    console.log("Fallback scan error:", e.message);
  }

  return null;
}

// ── Get posts (actual message content) for a conversation ─────────────────────
async function getConversationPosts(conversation_id) {
  const data = await guestyRequest(
    "GET",
    `/communication/conversations/${conversation_id}/posts`,
    { limit: 100 }
  );
  // Normalize across different response shapes
  return data.posts || data.data?.posts || data.results || (Array.isArray(data) ? data : []);
}

// ── MCP Tool Registration ─────────────────────────────────────────────────────
// Called for every request to create a fresh server instance (stateless HTTP)
function createMcpServer() {
  const server = new McpServer({ name: "guesty-mcp", version: "1.0.0" });

// list_listings
server.tool("list_listings", "Get all Guesty property listings for Ventur Group", {
  limit: z.number().default(25),
  skip: z.number().default(0),
}, async ({ limit, skip }) => {
  const data = await guestyRequest("GET", "/listings", {
    limit, skip, fields: "_id nickname title address"
  });
  const listings = data.results || data.listings || data.data?.results || [];
  return { content: [{ type: "text", text: JSON.stringify(listings) }] };
});

// get_listing
server.tool("get_listing", "Get full details for a single Guesty listing", {
  listing_id: z.string(),
}, async ({ listing_id }) => {
  const data = await guestyRequest("GET", `/listings/${listing_id}`);
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

// list_reservations
server.tool("list_reservations", "Get reservations with optional filters by listing, status, and date range", {
  listing_id: z.string().optional(),
  status: z.enum(["inquiry","reserved","confirmed","canceled","declined","expired","closed","checked_in","checked_out"]).optional(),
  check_in_from: z.string().optional().describe("ISO date e.g. 2025-01-01"),
  check_in_to: z.string().optional().describe("ISO date e.g. 2025-12-31"),
  limit: z.number().default(20),
  skip: z.number().default(0),
}, async ({ listing_id, status, check_in_from, check_in_to, limit, skip }) => {
  const params = { limit: Math.min(limit * 3, 100), skip };
  if (status) params.status = status;
  if (check_in_from) params["checkIn[from]"] = check_in_from;
  if (check_in_to) params["checkIn[to]"] = check_in_to;

  const data = await guestyRequest("GET", "/reservations", params);
  let reservations = data.results || data.reservations || data.data?.results || [];

  if (listing_id) {
    reservations = reservations.filter(r =>
      r.listingId === listing_id ||
      r.listing?._id === listing_id ||
      r.unitTypeId === listing_id
    );
  }

  return { content: [{ type: "text", text: JSON.stringify(reservations.slice(0, limit)) }] };
});

// get_reservation
server.tool("get_reservation", "Get full details for a single reservation", {
  reservation_id: z.string(),
}, async ({ reservation_id }) => {
  const data = await guestyRequest("GET", `/reservations/${reservation_id}`);
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

// get_reservation_financials
server.tool("get_reservation_financials", "Get financial breakdown for a reservation", {
  reservation_id: z.string(),
}, async ({ reservation_id }) => {
  const data = await guestyRequest("GET", `/reservations/${reservation_id}`, {
    fields: "money nightlyRate nightsCount totals fareAccommodation cleaningFee"
  });
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

// list_guests
server.tool("list_guests", "Search Guesty guests by name or email", {
  search: z.string().optional(),
  limit: z.number().default(20),
  skip: z.number().default(0),
}, async ({ search, limit, skip }) => {
  const params = { limit, skip };
  if (search) params.q = search;
  const data = await guestyRequest("GET", "/guests", params);
  const guests = data.results || data.guests || [];
  return { content: [{ type: "text", text: JSON.stringify(guests) }] };
});

// get_guest
server.tool("get_guest", "Get full profile for a guest", {
  guest_id: z.string(),
}, async ({ guest_id }) => {
  const data = await guestyRequest("GET", `/guests/${guest_id}`);
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

// get_conversation — CORE TOOL for Knowledge Base Builder
server.tool("get_conversation", "Get the full message thread for a reservation", {
  reservation_id: z.string(),
}, async ({ reservation_id }) => {
  // Find conversation ID
  const conversationId = await findConversationId(reservation_id);

  if (!conversationId) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: "No conversation found",
          reservation_id,
          note: "Reservation may be Airbnb-native (messages stay on Airbnb) or no messages yet",
          cacheReady,
          cacheSize: conversationCache.size
        })
      }]
    };
  }

  // Get the actual posts/messages
  let posts = [];
  try {
    posts = await getConversationPosts(conversationId);
  } catch (e) {
    console.log("Error fetching posts:", e.message);
  }

  // Normalize to clean message objects
  const messages = posts
    .map(post => ({
      id: post._id,
      type: post.authorRole === "guest" ? "guest" : "host",
      authorName: post.authorName || post.author?.fullName || "",
      body: post.body || post.text || post.message || "",
      createdAt: post.createdAt || post.date || "",
      source: post.source || post.channel || ""
    }))
    .filter(m => m.body.trim());

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        conversation_id: conversationId,
        reservation_id,
        total_messages: messages.length,
        messages
      })
    }]
  };
});

// send_guest_message
server.tool("send_guest_message", "Send a message to a guest via Guesty inbox", {
  reservation_id: z.string(),
  message: z.string(),
}, async ({ reservation_id, message }) => {
  const conversationId = await findConversationId(reservation_id);
  if (!conversationId) {
    throw new Error(`No conversation found for reservation ${reservation_id}`);
  }
  const result = await guestyRequest(
    "POST",
    `/communication/conversations/${conversationId}/send-message`,
    {},
    { body: message }
  );
  return { content: [{ type: "text", text: JSON.stringify({ success: true, result }) }] };
});

// get_availability_calendar
server.tool("get_availability_calendar", "Get availability calendar for a listing", {
  listing_id: z.string(),
  start_date: z.string(),
  end_date: z.string(),
}, async ({ listing_id, start_date, end_date }) => {
  const data = await guestyRequest(
    "GET",
    `/availability-pricing/api/calendar/listings/${listing_id}`,
    { startDate: start_date, endDate: end_date }
  );
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
});

  return server;
}

// ── Webhook handler ───────────────────────────────────────────────────────────
function handleWebhookEvent(payload) {
  try {
    if (payload.conversation?._id) {
      indexConversation(payload.conversation);
    }
    if (payload.reservationId && payload.conversationId) {
      conversationCache.set(payload.reservationId, payload.conversationId);
    }
    const data = payload.data || {};
    if (data.reservationId && data.conversationId) {
      conversationCache.set(data.reservationId, data.conversationId);
    }
  } catch (e) {
    console.error("Webhook error:", e);
  }
}

// ── Express App ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());



app.post("/cache/rebuild", async (req, res) => {
  buildCache();
  res.json({ status: "rebuilding" });
});

app.get("/test", async (req, res) => {
  const { reservation_id } = req.query;
  if (!reservation_id) return res.json({ error: "reservation_id required" });
  const convoId = await findConversationId(reservation_id).catch(() => null);
  res.json({ reservation_id, conversation_id: convoId, cacheSize: conversationCache.size });
});

app.get("/health", async (req, res) => {
  const clientId = process.env.GUESTY_CLIENT_ID;
  const clientSecret = process.env.GUESTY_CLIENT_SECRET;
  let tokenTest = null;
  try {
    const token = await getToken();
    tokenTest = token ? `OK (token length=${token.length})` : "No token returned";
  } catch (e) {
    tokenTest = `ERROR: ${e.message}`;
  }
  res.json({
    env: {
      GUESTY_CLIENT_ID: clientId ? `set (${clientId.slice(0,8)}...)` : "MISSING",
      GUESTY_CLIENT_SECRET: clientSecret ? `set (length=${clientSecret.length})` : "MISSING",
    },
    tokenTest,
    cacheReady,
    cacheSize: conversationCache.size,
    uptime: Math.round(process.uptime())
  });
});

app.post("/webhook", (req, res) => {
  handleWebhookEvent(req.body);
  res.sendStatus(200);
});

// SSE transport (legacy /sse endpoint)
const sseTransports = {};
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;
  const srv = createMcpServer();
  await srv.connect(transport);
});
app.post("/messages", async (req, res) => {
  const transport = sseTransports[req.query.sessionId];
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res, req.body);
});

// StreamableHTTP transport — stateless, new server+transport per request
app.post("/mcp", async (req, res) => {
  try {
    const srv = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await srv.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("finish", () => srv.close().catch(() => {}));
  } catch (e) {
    console.error("MCP POST error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.get("/mcp", async (req, res) => {
  try {
    const srv = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await srv.connect(transport);
    await transport.handleRequest(req, res);
    res.on("finish", () => srv.close().catch(() => {}));
  } catch (e) {
    console.error("MCP GET error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

app.delete("/mcp", (req, res) => res.status(200).end());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Guesty MCP running on port ${PORT}`);
  console.log(`GUESTY_CLIENT_ID set: ${!!process.env.GUESTY_CLIENT_ID}`);
  console.log(`GUESTY_CLIENT_SECRET set: ${!!process.env.GUESTY_CLIENT_SECRET}`);
});
