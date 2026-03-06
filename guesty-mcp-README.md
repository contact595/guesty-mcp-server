# Guesty MCP Server

A Model Context Protocol (MCP) server for Guesty — gives Claude and HostHub direct access to your Guesty account.

## Tools Available

| Tool | Description |
|------|-------------|
| `list_listings` | All properties with id, nickname, address |
| `get_listing` | Full details for one property |
| `list_reservations` | Reservations with filters (status, dates, listing) |
| `get_reservation` | Full reservation details |
| `update_reservation` | Update notes or custom fields |
| `list_guests` | Search guests by name/email |
| `get_guest` | Full guest profile |
| `send_guest_message` | Send message via Guesty inbox |
| `get_conversation` | Get message thread for a reservation |
| `get_availability_calendar` | Availability/pricing calendar for a listing |
| `get_reservation_financials` | Host payout, fees, taxes breakdown |

## Setup

### 1. Get Guesty API Credentials
1. Log into Guesty → **Integrations → API & Webhooks**
2. Click **Create a new application**
3. Copy your **Client ID** and **Client Secret**

### 2. Deploy to Render
1. Push this folder to a GitHub repo (e.g. `guesty-mcp`)
2. In Render → **New Web Service** → connect the repo
3. Add environment variables:
   - `GUESTY_CLIENT_ID`
   - `GUESTY_CLIENT_SECRET`
4. Build command: `npm install`
5. Start command: `node index.js`

Your MCP URL will be: `https://guesty-mcp-xxxx.onrender.com/sse`

### 3. Connect to Claude.ai
In Claude.ai Settings → **Integrations** → **Add custom MCP server**:
```
URL: https://your-render-url.onrender.com/sse
```

### 4. Connect to HostHub
Add to your HostHub backend `.env`:
```
GUESTY_MCP_URL=https://your-render-url.onrender.com/sse
```

## Local Development
```bash
cp .env.example .env
# Fill in your credentials
node index.js
# Server runs on http://localhost:3001/sse
```
