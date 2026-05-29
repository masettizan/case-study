# PartSelect Assistant

A focused chat agent for the **PartSelect** e-commerce site, scoped to
**refrigerator** and **dishwasher** parts. It helps customers find parts,
look up a part by number, check whether a part fits their appliance model,
follow installation steps, troubleshoot symptoms, and manage a cart.

Built for the Instalily case study.

---

## What it does

| Capability | Example query | How |
|---|---|---|
| Part lookup | "How can I install part number **PS11752778**?" | `get_part_details` + `get_installation_guide` |
| Compatibility | "Is **PS11756150** compatible with my **WDT780SAEM1** model?" | `check_compatibility` |
| Troubleshooting | "The ice maker on my Whirlpool fridge is not working." | `diagnose_symptom` → likely-cause parts |
| Search | "My dishwasher won't drain — what part do I need?" | `search_parts` / `diagnose_symptom` |
| Transactions | "Add PS11722098 to my cart" | `add_to_cart`, `view_cart` |
| Scope guard | "What's the weather?" | Politely declines, steers back |

The agent renders **rich inline UI** in the chat — product cards (price, stock,
rating, PS#), a compatibility badge, step-by-step install guides with video
links, and a live cart — not just text.

---

## Architecture

```
React (CRA) chat UI ──POST /api/chat──► Express backend
  ChatWindow + Widgets                    │
  (product cards, compat,                 ├─ Claude agentic tool-use loop
   install guide, cart)                   │    (system prompt = strict scope)
        ▲                                 ├─ tools.js  (search / details /
        │  { content, widgets[] }         │             compatibility / install /
        └─────────────────────────────────┤             diagnose / cart)
                                          └─ catalog.js (mock PartSelect data)
```

**Agentic loop** ([server/index.js](server/index.js)): each turn sends the full
conversation + tool schemas to Claude. The model decides which tools to call,
the backend runs them locally, feeds results back, and loops (up to 6 rounds)
until the model produces a final answer. Tool handlers also emit `widgets` that
the frontend renders inline.

**Scope is enforced two ways**: a strict system prompt (decline anything outside
fridge/dishwasher parts) and tools that only ever touch the refrigerator/
dishwasher catalog. The model is told to get all facts from tools and never
invent part numbers, prices, or compatibility.

**No-key fallback**: if `ANTHROPIC_API_KEY` is unset, the backend runs a
deterministic rule-based agent over the same tools, so the app is fully
demoable without credentials.

### Extensibility
- **Swap the data source**: `catalog.js` is the only thing tied to mock data.
  Replace it with PartSelect's real product API or a vector store over scraped
  part pages — the tool contracts in `tools.js` don't change.
- **Add a capability**: add a tool spec + handler in `tools.js` (e.g. order
  status, return/RMA, warranty). The agent picks it up automatically; add a
  widget type in `Widgets.js` if it needs rich UI.
- **Stateful cart/orders**: the in-memory cart in `tools.js` swaps cleanly for a
  DB-backed store keyed by session/user.

---

## Run it

```bash
npm install

# optional — enables the real Claude agent (otherwise fallback mode runs)
cp .env.example .env        # then add ANTHROPIC_API_KEY

npm run dev                 # starts backend (:8000) + frontend (:3000)
```

Or run the two processes separately:

```bash
npm run server              # backend on http://localhost:8000
npm start                   # frontend on http://localhost:3000
```

Health check: `GET http://localhost:8000/api/health` →
`{ ok: true, mode: "claude" | "fallback" }`.

---

## Project layout

```
server/
  index.js     Express app + Claude agentic loop + no-key fallback
  tools.js     tool schemas + handlers + cart store
  catalog.js   mock fridge/dishwasher catalog (swap for real data source)
src/
  api/api.js          frontend → backend bridge (sends full history)
  components/
    ChatWindow.js     chat state, suggestions, typing indicator
    Widgets.js        product card / compatibility / install / cart UI
  App.js / App.css    PartSelect-branded shell
```

## Notes & trade-offs
- Catalog is mock data with realistic PartSelect numbers/models; production
  would back the tools with PartSelect's catalog + a retrieval layer.
- Cart/orders are in-memory (single demo session). Checkout is a stub.
- Compatibility answers are honest: if a model isn't in the verified-fit list,
  the agent says so rather than guessing.
