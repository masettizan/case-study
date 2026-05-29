# PartSelect MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) stdio server that
exposes the PartSelect tool set to any MCP client - Claude Desktop, the Claude
Agent SDK, Cursor, etc.

Scope: **refrigerator + dishwasher parts only.**

## Files

| File | Role |
|------|------|
| `index.mjs` | MCP server - registers the 8 tools, wires them to the data layer |
| `dataSource.mjs` | Unified data layer over the mock catalog + live scraper |
| `smoke.mjs` | End-to-end test that drives the server with the MCP client |

It reuses the existing modules unchanged:
- [`server/catalog.js`](../catalog.js) - mock catalog (offline data)
- [`server/scraper.js`](../scraper.js) - live partselect.com scraper (fetch → Playwright fallback)

## Tools

| Tool | Input | Purpose |
|------|-------|---------|
| `search_parts` | `query`, `appliance?`, `brand?`, `limit?` | Free-text / symptom search |
| `get_part` | `part_number` | Full part record by PS# or mfr# |
| `check_compatibility` | `part_number`, `model_number` | Does this part fit this model? |
| `get_model` | `model_number` | Model record + fitting parts |
| `diagnose` | `symptom`, `appliance_type?`, `model_number?` | Symptom → candidate parts |
| `get_installation` | `part_number` | Difficulty, time, steps, video |
| `get_policy` | `topic` (returns/warranty/shipping/contact/order_status) | Policy facts |
| `lookup_order` | `order_number`, `email` | Order status (stub - needs auth integration) |

## Data modes

Set `PARTSELECT_DATA`:

| Mode | Behavior |
|------|----------|
| `offline` *(default)* | Mock catalog. Fast, deterministic, demo-safe. |
| `live` | Scrape partselect.com. Needs network; install Playwright for the 403 bypass. |
| `auto` | Try live, fall back to offline on error/empty. |

For live mode's 403 bypass:
```bash
npm i playwright && npx playwright install chromium
```

## Run

```bash
npm run mcp                         # offline (default)
PARTSELECT_DATA=auto npm run mcp    # live with offline fallback
npm run mcp:inspect                 # MCP Inspector UI
node server/mcp/smoke.mjs           # end-to-end smoke test
```

> stdout is the protocol channel - the server logs only to stderr. Don't `console.log` to stdout in tool handlers.

## Register in Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "partselect": {
      "command": "node",
      "args": ["c:/Users/Ifunn/OneDrive/Desktop/JOB_SEARCH/case-study/server/mcp/index.mjs"],
      "env": { "PARTSELECT_DATA": "offline" }
    }
  }
}
```

## How it relates to the chat backend

[`server/index.js`](../index.js) runs its own in-process tool loop for the web
chat UI. This MCP server exposes the **same capabilities** over a standard
protocol so external MCP clients can use them too. Both read the same catalog +
scraper, so behavior stays consistent. As the project grows, the web backend
could itself become an MCP client of this server - one tool implementation,
many consumers.
