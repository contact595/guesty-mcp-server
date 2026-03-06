const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BASE_URL = process.env.BASE_URL || "https://guesty-mcp.onrender.com";

// ─── In-memory OAuth stores ──────────────────────────────────────────────────
const clients = {};
const authCodes = {};
const accessTokens = {};

// ─── Guesty Token Cache ──────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = null;

async function getGuestyToken() {
  if (cachedToken && tokenExpiresAt && Date.now() < tokenExpiresAt) return cachedToken;
  const res = await axios.post(
    "https://open-api.guesty.com/oauth2/token",
    new URLSearchParams({
      grant_type: "client_credentials",
      scope: "open-api",
      client_id: process.env.GUESTY_CLIENT_ID,
      client_secret: process.env.GUESTY_CLIENT_SECRET,
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } }
  );
  cachedToken = res.data.access_token;
  tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
  return cachedToken;
}

// ─── Sleep helper ─────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Guesty request with automatic 429 retry ─────────────────────────────────
async function guestyRequest(method, path, params = {}, body = null, retries = 3) {
  const token = await getGuestyToken();
  const config = {
    method,
    url: `https://open-api.guesty.com/v1${path}`,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  };
  if (method === "GET" && Object.keys(params).length) {
    config.params = params;
    config.paramsSerializer = (p) =>
      Object.entries(p).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  }
  if (body) {
    config.data = body;
    config.headers["Content-Type"] = "application/json";
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await axios(config);
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const retryAfter = err.response?.headers?.["retry-after"];
      const detail = JSON.stringify(err.response?.data || err.message);

      console.error(`[Guesty] ${method} ${path} => ${status} (attempt ${attempt}/${retries}): ${detail}`);

      if (status === 429 && attempt < retries) {
        // Honour Guesty's Retry-After header, or back off exponentially
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : Math.pow(2, attempt) * 1000;
        console.log(`[Guesty] Rate limited. Waiting ${waitMs}ms before retry...`);
        await sleep(waitMs);
        continue;
      }

      throw err;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OAuth 2.1 Endpoints (required by Claude.ai)
// ═══════════════════════════════════════════════════════════════════════════

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: BASE_URL,
    authorization_servers: [BASE_URL],
    bearer_methods_supported: ["header"],
  });
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json({
    issuer: BASE_URL,
    authorization_endpoint: `${BASE_URL}/authorize`,
    token_endpoint: `${BASE_URL}/token`,
    registration_endpoint: `${BASE_URL}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  });
});

app.post("/register", (req, res) => {
  const clientId = `claude_${crypto.randomBytes(8).toString("hex")}`;
  clients[clientId] = { client_id: clientId, redirect_uris: req.body.redirect_uris || [], client_name: req.body.client_name || "Claude" };
  console.log(`[OAuth] Registered: ${clientId}`);
  res.status(201).json({
    client_id: clientId,
    client_secret_expires_at: 0,
    redirect_uris: clients[clientId].redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    client_name: clients[clientId].client_name,
  });
});

app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;
  if (!client_id || !redirect_uri) return res.status(400).send("Missing required params");

  const code = crypto.randomBytes(16).toString("hex");
  authCodes[code] = { client_id, redirect_uri, code_challenge, code_challenge_method, created_at: Date.now() };
  console.log(`[OAuth] Auth code issued for: ${client_id}`);

  try {
    const url = new URL(redirect_uri);
    url.searchParams.set("code", code);
    if (state) url.searchParams.set("state", state);
    res.redirect(url.toString());
  } catch (e) {
    res.status(400).send("Invalid redirect_uri");
  }
});

app.post("/token", (req, res) => {
  const { grant_type, code, code_verifier } = req.body;
  if (grant_type !== "authorization_code") return res.status(400).json({ error: "unsupported_grant_type" });

  const authCode = authCodes[code];
  if (!authCode) {
    console.log(`[OAuth] Invalid code: ${code}, stored codes: ${Object.keys(authCodes).join(", ")}`);
    return res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired code" });
  }

  if (authCode.code_challenge && code_verifier) {
    const hash = crypto.createHash("sha256").update(code_verifier).digest("base64url");
    if (hash !== authCode.code_challenge) return res.status(400).json({ error: "invalid_grant", error_description: "PKCE failed" });
  }

  const accessToken = crypto.randomBytes(32).toString("hex");
  accessTokens[accessToken] = { client_id: authCode.client_id, expires_at: Date.now() + 365 * 24 * 60 * 60 * 1000 };
  delete authCodes[code];

  console.log(`[OAuth] Token issued for: ${authCode.client_id}`);
  res.json({ access_token: accessToken, token_type: "Bearer", expires_in: 31536000 });
});

// ═══════════════════════════════════════════════════════════════════════════
// Build MCP Server (tools)
// ═══════════════════════════════════════════════════════════════════════════
function buildMcpServer() {
  const server = new McpServer({ name: "guesty-mcp", version: "3.0.0" });

  server.tool("list_listings", "Get all Guesty property listings for Ventur Group",
    { limit: z.number().optional().default(25), skip: z.number().optional().default(0) },
    async ({ limit, skip }) => {
      const data = await guestyRequest("GET", "/listings", { limit, skip, fields: "_id nickname title address type" });
      const out = (data.results || data).map(l => ({ id: l._id, nickname: l.nickname, title: l.title, address: l.address?.full, type: l.type }));
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
  );

  server.tool("get_listing", "Get full details for a single Guesty listing",
    { listing_id: z.string() },
    async ({ listing_id }) => {
      const data = await guestyRequest("GET", `/listings/${listing_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("list_reservations", "Get reservations with optional filters by listing, status, and date range",
    {
      listing_id: z.string().optional(),
      status: z.enum(["inquiry","reserved","confirmed","canceled","declined","expired","closed","checked_in","checked_out"]).optional(),
      check_in_from: z.string().optional().describe("ISO date e.g. 2025-01-01"),
      check_in_to: z.string().optional().describe("ISO date e.g. 2025-12-31"),
      limit: z.number().optional().default(20),
      skip: z.number().optional().default(0),
    },
    async ({ listing_id, status, check_in_from, check_in_to, limit, skip }) => {
      const filters = [];
      if (listing_id) filters.push({ field: "listingId", operator: "$in", value: [listing_id] });
      if (status) filters.push({ field: "status", operator: "$eq", value: status });
      if (check_in_from) filters.push({ field: "checkInDateLocalized", operator: "$gte", value: check_in_from });
      if (check_in_to) filters.push({ field: "checkInDateLocalized", operator: "$lte", value: check_in_to });
      const params = { limit, skip, sort: "_id" };
      if (filters.length) params.filters = JSON.stringify(filters);
      const data = await guestyRequest("GET", "/reservations", params);
      let results = data.results || data;
      if (listing_id) results = results.filter(r => r.listingId === listing_id);
      const out = results.map(r => ({
        id: r._id, confirmationCode: r.confirmationCode, status: r.status,
        checkIn: r.checkIn, checkOut: r.checkOut, listingId: r.listingId,
        guestName: r.guest?.fullName, totalPaid: r.money?.totalPaid,
        currency: r.money?.currency, channel: r.source, nights: r.nightsCount,
      }));
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
  );

  server.tool("get_reservation", "Get full details for a single reservation",
    { reservation_id: z.string() },
    async ({ reservation_id }) => {
      const data = await guestyRequest("GET", `/reservations/${reservation_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("get_reservation_financials", "Get financial breakdown for a reservation",
    { reservation_id: z.string() },
    async ({ reservation_id }) => {
      const data = await guestyRequest("GET", `/reservations/${reservation_id}`);
      const m = data.money || {};
      return { content: [{ type: "text", text: JSON.stringify({
        confirmationCode: data.confirmationCode, currency: m.currency,
        totalPaid: m.totalPaid, hostPayout: m.hostPayout, cleaningFee: m.cleaningFee,
        netIncome: m.netIncome, accommodationFare: m.fareAccommodation,
      }, null, 2) }] };
    }
  );

  server.tool("list_guests", "Search Guesty guests by name or email",
    { search: z.string().optional(), limit: z.number().optional().default(20), skip: z.number().optional().default(0) },
    async ({ search, limit, skip }) => {
      const params = { limit, skip };
      if (search) params.q = search;
      const data = await guestyRequest("GET", "/guests-crud", params);
      const out = (data.results || data).map(g => ({ id: g._id, fullName: g.fullName, email: g.email, phone: g.phone }));
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
  );

  server.tool("get_guest", "Get full profile for a guest",
    { guest_id: z.string() },
    async ({ guest_id }) => {
      const data = await guestyRequest("GET", `/guests-crud/${guest_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── FIXED: look up conversation by reservationId first, then send message ──
  server.tool("send_guest_message", "Send a message to a guest via Guesty inbox",
    { reservation_id: z.string(), message: z.string() },
    async ({ reservation_id, message }) => {
      const list = await guestyRequest("GET", "/communication/conversations", { reservationId: reservation_id, limit: 1 });
      const conversation = (list.results || list)[0];
      if (!conversation) throw new Error("No conversation found for this reservation");
      const data = await guestyRequest("POST", `/communication/conversations/${conversation._id}/send-message`, {}, { body: message, type: "host" });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, messageId: data._id }) }] };
    }
  );

  // ── FIXED: look up conversation by reservationId first, then fetch full thread ──
  server.tool("get_conversation", "Get the message thread for a reservation",
    { reservation_id: z.string() },
    async ({ reservation_id }) => {
      const list = await guestyRequest("GET", "/communication/conversations", { reservationId: reservation_id, limit: 1 });
      console.log(`[get_conversation] /conversations?reservationId=${reservation_id} => count: ${(list.results || list).length}`);
      const conversation = (list.results || list)[0];
      if (!conversation) return { content: [{ type: "text", text: JSON.stringify({ error: "No conversation found", reservation_id }) }] };
      const data = await guestyRequest("GET", `/communication/conversations/${conversation._id}/posts`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("get_availability_calendar", "Get availability calendar for a listing",
    { listing_id: z.string(), start_date: z.string(), end_date: z.string() },
    async ({ listing_id, start_date, end_date }) => {
      const data = await guestyRequest("GET", `/availability-pricing/api/v3/listings/${listing_id}/calendar`, { startDate: start_date, endDate: end_date });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// ═══════════════════════════════════════════════════════════════════════════
// Streamable HTTP MCP Endpoint — stateless mode
// ═══════════════════════════════════════════════════════════════════════════
const mcpServer = buildMcpServer();

async function handleMcpRequest(req, res) {
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("finish", () => transport.close());
    res.on("close", () => transport.close());
  } catch (err) {
    console.error("[MCP error]", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
}

app.post("/mcp", handleMcpRequest);
app.get("/mcp", handleMcpRequest);
app.delete("/mcp", handleMcpRequest);

// ─── Health ──────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "guesty-mcp", version: "4.0.0", transport: "streamable-http" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Guesty MCP v4 running on port ${PORT}`);
  console.log(`MCP endpoint: ${BASE_URL}/mcp`);
});
