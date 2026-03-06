const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { z } = require("zod");

const app = express();
app.use(cors());
app.use(express.json());

// ─── Token Cache ────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = null;

async function getGuestyToken() {
  if (cachedToken && tokenExpiresAt && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

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
  // Cache for 23 hours (expires_in is typically 86400s / 24h)
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

// ─── MCP Server Factory ──────────────────────────────────────────────────────
function createMcpServer() {
  const server = new McpServer({
    name: "guesty-mcp",
    version: "1.0.0",
  });

  // ── Tool: List Listings ──────────────────────────────────────────────────
  server.tool(
    "list_listings",
    "Get all Guesty property listings with basic info (id, title, address, type)",
    { limit: z.number().optional().default(25), skip: z.number().optional().default(0) },
    async ({ limit, skip }) => {
      const data = await guestyRequest("GET", "/listings", { limit, skip, fields: "_id nickname title address type picture" });
      const listings = (data.results || data).map((l) => ({
        id: l._id,
        nickname: l.nickname,
        title: l.title,
        address: l.address?.full,
        type: l.type,
        picture: l.picture?.thumbnail,
      }));
      return { content: [{ type: "text", text: JSON.stringify(listings, null, 2) }] };
    }
  );

  // ── Tool: Get Listing ────────────────────────────────────────────────────
  server.tool(
    "get_listing",
    "Get full details for a single Guesty listing",
    { listing_id: z.string().describe("Guesty listing ID (_id)") },
    async ({ listing_id }) => {
      const data = await guestyRequest("GET", `/listings/${listing_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Tool: List Reservations ──────────────────────────────────────────────
  server.tool(
    "list_reservations",
    "Get reservations with optional filters by listing, status, and date range",
    {
      listing_id: z.string().optional().describe("Filter by listing ID"),
      status: z.enum(["inquiry", "reserved", "confirmed", "canceled", "declined", "expired", "closed", "checked_in", "checked_out"]).optional(),
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
      const reservations = (data.results || data).map((r) => ({
        id: r._id,
        confirmationCode: r.confirmationCode,
        status: r.status,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        listingId: r.listingId,
        guestId: r.guestId,
        guestName: r.guest?.fullName,
        totalPaid: r.money?.totalPaid,
        currency: r.money?.currency,
        channel: r.source,
        nightsCount: r.nightsCount,
      }));
      return { content: [{ type: "text", text: JSON.stringify(reservations, null, 2) }] };
    }
  );

  // ── Tool: Get Reservation ────────────────────────────────────────────────
  server.tool(
    "get_reservation",
    "Get full details for a single reservation including guest, financials, and notes",
    { reservation_id: z.string().describe("Guesty reservation ID") },
    async ({ reservation_id }) => {
      const data = await guestyRequest("GET", `/reservations/${reservation_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Tool: Update Reservation ─────────────────────────────────────────────
  server.tool(
    "update_reservation",
    "Update notes or custom fields on a reservation",
    {
      reservation_id: z.string(),
      notes: z.string().optional().describe("Internal notes for the reservation"),
      custom_fields: z.record(z.string()).optional().describe("Key-value custom field updates"),
    },
    async ({ reservation_id, notes, custom_fields }) => {
      const body = {};
      if (notes !== undefined) body.notes = notes;
      if (custom_fields) body.customFields = custom_fields;
      const data = await guestyRequest("PUT", `/reservations/${reservation_id}`, {}, body);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, id: data._id }, null, 2) }] };
    }
  );

  // ── Tool: List Guests ────────────────────────────────────────────────────
  server.tool(
    "list_guests",
    "Search Guesty guests by name or email",
    {
      search: z.string().optional().describe("Name or email search query"),
      limit: z.number().optional().default(20),
      skip: z.number().optional().default(0),
    },
    async ({ search, limit, skip }) => {
      const params = { limit, skip };
      if (search) params.q = search;
      const data = await guestyRequest("GET", "/guests-crud", params);
      const guests = (data.results || data).map((g) => ({
        id: g._id,
        fullName: g.fullName,
        email: g.email,
        phone: g.phone,
        totalReservations: g.totalReservations,
      }));
      return { content: [{ type: "text", text: JSON.stringify(guests, null, 2) }] };
    }
  );

  // ── Tool: Get Guest ──────────────────────────────────────────────────────
  server.tool(
    "get_guest",
    "Get full profile for a single guest",
    { guest_id: z.string() },
    async ({ guest_id }) => {
      const data = await guestyRequest("GET", `/guests-crud/${guest_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Tool: Send Guest Message ─────────────────────────────────────────────
  server.tool(
    "send_guest_message",
    "Send a message to a guest via Guesty's unified inbox",
    {
      reservation_id: z.string(),
      message: z.string().describe("Message body to send to the guest"),
    },
    async ({ reservation_id, message }) => {
      const data = await guestyRequest("POST", `/conversations/${reservation_id}/messages`, {}, {
        body: message,
        type: "host",
      });
      return { content: [{ type: "text", text: JSON.stringify({ success: true, messageId: data._id }, null, 2) }] };
    }
  );

  // ── Tool: Get Conversation ───────────────────────────────────────────────
  server.tool(
    "get_conversation",
    "Get the message thread for a reservation",
    { reservation_id: z.string() },
    async ({ reservation_id }) => {
      const data = await guestyRequest("GET", `/conversations/${reservation_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Tool: Get Calendar ───────────────────────────────────────────────────
  server.tool(
    "get_availability_calendar",
    "Get availability calendar for a listing over a date range",
    {
      listing_id: z.string(),
      start_date: z.string().describe("ISO date e.g. 2025-06-01"),
      end_date: z.string().describe("ISO date e.g. 2025-06-30"),
    },
    async ({ listing_id, start_date, end_date }) => {
      const data = await guestyRequest("GET", `/availability-pricing/api/v3/listings/${listing_id}/calendar`, {
        startDate: start_date,
        endDate: end_date,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Tool: Get Financial Summary ──────────────────────────────────────────
  server.tool(
    "get_reservation_financials",
    "Get the financial breakdown (host payout, fees, taxes) for a reservation",
    { reservation_id: z.string() },
    async ({ reservation_id }) => {
      const data = await guestyRequest("GET", `/reservations/${reservation_id}`, {}, null);
      const money = data.money || {};
      const summary = {
        reservationId: reservation_id,
        confirmationCode: data.confirmationCode,
        currency: money.currency,
        totalPaid: money.totalPaid,
        hostPayout: money.hostPayout,
        guestServiceFee: money.guestServiceFee,
        hostServiceFee: money.hostServiceFee,
        taxes: money.taxes,
        netIncome: money.netIncome,
        accommodationFare: money.fareAccommodation,
        cleaningFee: money.cleaningFee,
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  return server;
}

// ─── SSE Endpoint ────────────────────────────────────────────────────────────
const transports = {};

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports[transport.sessionId];
  });

  const server = createMcpServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) return res.status(404).send("Session not found");
  await transport.handlePostMessage(req, res);
});

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "guesty-mcp", timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Guesty MCP server running on port ${PORT}`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
