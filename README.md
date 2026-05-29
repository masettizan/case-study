# PartSelect Assistant

A focused chat agent for the **PartSelect** e-commerce site, scoped to
**refrigerator** and **dishwasher** parts. It helps customers find parts,
look up a part by number, check whether a part fits their appliance model,
list the parts for a model, follow installation steps, troubleshoot symptoms,
answer policy questions, and manage a cart.

Built for the Instalily case study.

---

## What it does

| Capability | Example query | Tool(s) |
|---|---|---|
| Part lookup | "How can I install part number **PS11752778**?" | `get_part` + `get_installation` |
| Compatibility | "Is **PS11756150** compatible with my **WDT780SAEM1** model?" | `check_compatibility` |
| Troubleshooting | "The ice maker on my Whirlpool fridge is not working." | `diagnose` → likely-cause parts |
| Search | "My dishwasher won't drain - what part do I need?" | `search_parts` / `diagnose` |
| Parts for a model | "What door part fits model **WDT780SAEM1**?" | `get_model` (with `part_type`) |
| Policy | "What's your return policy?" | `get_policy` |
| Order status | "Where's my order?" | `lookup_order` (stub - needs auth integration) |
| Transactions | "Add PS11722098 to my cart" | `add_to_cart`, `view_cart` |
| Scope guard | "What's the weather?" | Politely declines, steers back |

The agent renders **rich inline UI** in the chat - product cards (price, stock,
rating, PS#), a compatibility badge, step-by-step install guides with video
links, and a live cart - not just text.

---

## Architecture

```
React (CRA) chat UI ──POST /api/chat──► Express backend ──MCP (stdio)──► PartSelect MCP server
  ChatWindow + Widgets                    │  agentic tool-use loop          │  8 tools
  (product cards, compat,                 │  (system prompt = strict scope) │
   install guide, cart)                   │  provider-agnostic LLM:         ▼
        ▲                                 │   ollama | vllm | gemini    dataSource.mjs
        │  { content, widgets[] }         │                              ├─ offline → catalog.js (mock)
        └─────────────────────────────────┤  cart (in-memory, local)     └─ live    → scraper.js (partselect.com)
                                          └─ snake_case → camelCase widget map
```

**Agentic loop** ([server/index.js](server/index.js)): each turn sends the full
conversation + tool schemas to the model. The model decides which tools to call
(it may chain several in one turn - e.g. `get_part` then `check_compatibility`),
the backend runs each tool via the MCP client, feeds the results back, and loops
(up to 6 rounds) until the model produces a final answer. Tool results are mapped
to `widgets` the frontend renders inline.

**Provider-agnostic LLM**: the same loop runs against a local **Ollama** model, a
self-hosted **vLLM** server, or **Gemini**'s OpenAI-compatible endpoint. Selected
by `LLM_PROVIDER` (vLLM and Gemini share one OpenAI-compatible client; only base
URL, model, and key differ). No key and no provider → local Ollama. If the chosen
backend is unreachable, `/api/chat` returns a 500 - there is no rule-based fallback.

**Tools live in an MCP server** ([server/mcp/index.mjs](server/mcp/index.mjs)):
the 8 tools are exposed over the **Model Context Protocol**, so the *same* server
also plugs into Claude Desktop, Cursor, or the Agent SDK with no code change - one
tool implementation, many clients (see [server/mcp/README.md](server/mcp/README.md)).
The web backend is just one MCP client.

**Two data backends, one contract** ([server/mcp/dataSource.mjs](server/mcp/dataSource.mjs)):
`PARTSELECT_DATA` selects `offline` (mock [catalog.js](server/catalog.js) - fast,
deterministic, demo-safe), `live` ([scraper.js](server/scraper.js) over
partselect.com, enriched with real price/stock), or `auto` (live, falling back to
offline on error). Every data function returns the same JSON shape, so the tools
never branch on the source.

**Scope is enforced two ways**: a strict system prompt (decline anything outside
fridge/dishwasher parts) and tools that only ever touch the refrigerator/
dishwasher catalog. The model is told to get all facts from tools and never invent
part numbers, prices, or compatibility - if a fit can't be verified, it says so.

### Extensibility
- **Add a capability**: register a tool spec + handler in
  [server/mcp/index.mjs](server/mcp/index.mjs) (e.g. returns/RMA, warranty). The
  agent discovers it automatically; add a widget type in
  [src/components/Widgets.js](src/components/Widgets.js) if it needs rich UI.
- **Swap the data source**: [server/mcp/dataSource.mjs](server/mcp/dataSource.mjs)
  is the only thing tied to a backend. Replace the offline catalog or live scraper
  with PartSelect's real product API, or a vector store over scraped part pages -
  the tool contracts don't change.
- **Stateful cart/orders**: the in-memory cart in [server/index.js](server/index.js)
  swaps cleanly for a DB-backed store keyed by session/user. It lives in the web
  backend (not the shared MCP server) because it's per-session state.
- **Scale the model**: provider-agnostic loop - start on a local Ollama model for
  dev, point at a hosted vLLM/Gemini endpoint for production via env var.

---

## Run it

```bash
npm install

# optional - configures the LLM backend (defaults to local Ollama if unset)
cp .env.example .env        # then set LLM_PROVIDER / LLM_API_KEY as needed

npm run dev                 # starts backend (:8000) + frontend (:3000)
```

Or run the processes separately:

```bash
npm run server              # backend on http://localhost:8000
npm start                   # frontend on http://localhost:3000
npm run mcp                 # (optional) run the MCP server standalone over stdio
npm run mcp:inspect         # (optional) open the MCP inspector
```

**Data mode** is set by `PARTSELECT_DATA` (`offline` default | `live` | `auto`).
Offline is recommended for demos - deterministic and no site latency/403s.

Health check: `GET http://localhost:8000/api/health` →
`{ ok: true, mode: "ollama+mcp" | "vllm+mcp" | "gemini+mcp", data: "offline" | "live" | "auto", ... }`.

---

## Project layout

```
server/
  index.js          Express app + agentic loop + provider selection + local cart
  mcpClient.js      stdio MCP client the backend uses to call the MCP server
  mcp/
    index.mjs       PartSelect MCP server - 8 tools over the Model Context Protocol
    dataSource.mjs  unified data layer: offline (catalog) | live (scraper) | auto
    README.md       MCP server docs + Claude Desktop / Cursor registration
  catalog.js        mock fridge/dishwasher catalog (offline data backend)
  scraper.js        partselect.com scraper (live data backend)
src/
  api/api.js          frontend → backend bridge (sends full history)
  components/
    ChatWindow.js     chat state, suggestions, typing indicator
    Widgets.js        product card / compatibility / install / cart UI
  App.js / App.css    PartSelect-branded shell
```


## Notes & trade-offs
- Offline catalog is mock data with realistic PartSelect numbers/models; live mode
  scrapes the real site (no public API), best-effort with caching and a 403 bypass.
- Cart/orders are in-memory (single demo session). Checkout is a stub.
- `lookup_order` is a stub: real order status needs an authenticated PartSelect
  integration, so it returns guidance, never fabricated order data.
- Compatibility answers are honest: if a model isn't in the verified-fit list, the
  agent says so rather than guessing.
