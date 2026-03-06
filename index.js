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

async function guestyRequest(method, path, params = {}, body = null) {
  const token = await getGuestyToken();
  const config = {
    method,
    url: `https://open-api.guesty.com/v1${path}`,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  };
  if (method === "GET" && Object.keys(params).length) config.params = params;
  if (body) { config.data = body; config.headers["Content-Type"] = "application/json"; }
  const res = await axios(config);
  return res.data;
}

// ═══════════════════════════════════════════════════════════════════════════
// OAuth 2.1 Endpoints
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
  clients[clientId] = {
    client_id: clientId,
    redirect_uris: req.body.redirect_uris || [],
    client_name: req.body.client_name || "Claude",
  };
  console.log(`[OAuth] Registered client: ${clientId}`);
  res.status(201).json({
    client_id: clientId,
    client_secret_expires_at: 0,
    redirect_uris: clients[clientId].redirect_uris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    client_name: clients[clientId].client_name,
  });
});

// Auto-approve: generate code and immediately redirect back to Claude
app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;
  if (!client_id || !redirect_uri) return res.status(400).send("Missing required params");

  const code = crypto.randomBytes(16).toString("hex");
  authCodes[code] = { client_id, redirect_uri, code_challenge, code_challenge_method, created_at: Date.now() };
  console.log(`[OAuth] Issuing code for client: ${client_id}`);

  try {
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);
    res.redirect(redirectUrl.toString());
  } catch (err) {
    res.status(400).send("Invalid redirect_uri");
  }
});

app.post("/token", (req, res) => {
  const { grant_type, code, code_verifier } = req.body;
  if (grant_type !== "authorization_code") return res.status(400).json({ error: "unsupported_grant_type" });

  const authCode = authCodes[code];
  if (!authCode) return res.status(400).json({ error: "invalid_grant", error_description: "Invalid or expired code" });

  // PKCE verification
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
// MCP Tools
// ═══════════════════════════════════════════════════════════════════════════
function buildMcpServer() {
  const server = new McpServer({ name: "guesty-mcp", version: "2.0.0" });

  server.tool("list_listings", "Get all Guesty property listings",
    { limit: z.number().optional().default(25), skip: z.number().optional().default(0) },
    async ({ limit, skip }) => {
      const data = await guestyRequest("GET", "/listings", { limit, skip, fields: "_id nickname title address type" });
      const out = (data.results || data).map(l => ({ id: l._id, nickname: l.nickname, title: l.title, address: l.address?.full, type: l.type }));
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    }
  );

  server.tool("get_listing", "Get full details for a single listing",
    { listing_id: z.string() },
    async ({ listing_id }) => {
      const data = await guestyRequest("GET", `/listings/${listing_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("list_reservations", "Get reservations with optional filters",
    {
      listing_id: z.string().optional(),
      status: z.enum(["inquiry","reserved","confirmed","canceled","declined","expired","closed","checked_in","checked_out"]).optional(),
      check_in_from: z.string().optional().describe("ISO date e.g. 2025-01-01"),
      check_in_to: z.string().optional().describe("ISO date e.g. 2025-12-31"),
      limit: z.number().optional().default(20),
      skip: z.number().optional().default(0),
    },
    async ({ listing_id, status, check_in_from, check_in_to, limit, skip }) => {
      const params = { limit, skip };
      if (listing_id) params.listingId = listing_id;
      if (status) params.status = status;
      if (check_in_from) params.checkInDateFrom = check_in_from;
      if (check_in_to) params.checkInDateTo = check_in_to;
      const data = await guestyRequest("GET", "/reservations", params);
      const out = (data.results || data).map(r => ({
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

  server.tool("list_guests", "Search guests by name or email",
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

  server.tool("send_guest_message", "Send a message to a guest",
    { reservation_id: z.string(), message: z.string() },
    async ({ reservation_id, message }) => {
      const data = await guestyRequest("POST", `/conversations/${reservation_id}/messages`, {}, { body: message, type: "host" });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, messageId: data._id }) }] };
    }
  );

  server.tool("get_conversation", "Get the message thread for a reservation",
    { reservation_id: z.string() },
    async ({ reservation_id }) => {
      const data = await guestyRequest("GET", `/conversations/${reservation_id}`);
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
// Streamable HTTP MCP Endpoint (Claude.ai uses this)
// ═══════════════════════════════════════════════════════════════════════════
app.all("/mcp", async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error("[MCP] Error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

// ─── Health ──────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "guesty-mcp", version: "3.0.0", transport: "streamable-http" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Guesty MCP v3 running on port ${PORT}`);
  console.log(`MCP endpoint: ${BASE_URL}/mcp`);
  console.log(`OAuth metadata: ${BASE_URL}/.well-known/oauth-authorization-server`);
});
