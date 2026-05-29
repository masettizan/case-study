// PartSelect chat agent backend.
//
// /api/chat runs an agentic tool-use loop. LLM_PROVIDER picks the model: a remote
// OpenAI-compatible server (vLLM / Gemini) when an API key is set, else local
// Ollama (qwen3). System prompt is scoped to refrigerator + dishwasher parts.
//
// Tools come from the MCP server (server/mcp/index.mjs) over stdio via
// server/mcpClient.js. Cart state lives here, not in the MCP server, so
// add_to_cart / view_cart are handled locally (reading part details via get_part).
//
// If the configured LLM is unreachable, /api/chat returns 500 (no fallback).

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mcp = require("./mcpClient");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.SERVER_PORT || process.env.PORT || 8000;
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen3";
const MAX_TOOL_ROUNDS = 6;

// ----- LLM provider selection ------------------------------------------------
// LLM_PROVIDER picks the agent backend explicitly: "gemini" | "vllm" | "ollama".
// Unset → "vllm" if an API key is present, else local "ollama". gemini and vllm
// are both reached through the SAME OpenAI-compatible /chat/completions client;
// only base URL, model, and key differ. No key (and no provider) → ollama.
// If the chosen backend is unreachable, the request errors (no fallback).
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || "";
const LLM_PROVIDER = (process.env.LLM_PROVIDER || (LLM_API_KEY ? "vllm" : "ollama")).toLowerCase();
const REMOTE_DEFAULTS = {
  // Gemini's OpenAI-compatible surface. Default to a fast, cheap model.
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash" },
  // vLLM has no universal default host - set LLM_BASE_URL to your server's /v1.
  // (Placeholder port 8000 differs from this backend's SERVER_PORT host.)
  vllm: { baseUrl: "http://localhost:8000/v1", model: "Qwen/Qwen2.5-7B-Instruct" },
};
const REMOTE_CFG = REMOTE_DEFAULTS[LLM_PROVIDER] || REMOTE_DEFAULTS.vllm;
const LLM_BASE_URL = (process.env.LLM_BASE_URL || REMOTE_CFG.baseUrl).replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL || REMOTE_CFG.model;
const IS_REMOTE = LLM_PROVIDER === "gemini" || LLM_PROVIDER === "vllm";

const SYSTEM_PROMPT = `You are the PartSelect Assistant, a focused customer-support agent for the \
PartSelect e-commerce site. You ONLY help with **refrigerator parts** and **dishwasher parts** \
and the tasks around them: finding the right part, looking up a part by number, checking whether \
a part fits a specific appliance model, listing the parts for a model, giving installation \
instructions, troubleshooting appliance symptoms, answering policy questions, and basic cart support.

SCOPE - strict:
- If the user asks about anything outside refrigerator/dishwasher parts and repair (other appliances, \
general chit-chat, coding, news, math, other retailers, opinions), politely decline in one sentence \
and steer back to fridge/dishwasher parts. Do NOT answer the off-topic question.
- Never invent part numbers, prices, compatibility, or specs. Get facts ONLY from tools. If a tool \
says a part isn't found or a fit can't be verified, say so honestly - never guess "incompatible".

GROUNDING - critical (do this before answering):
- Call the tool FIRST, then answer only from what it returned. Never claim a part exists, fits a model, \
or is "a door/drain/rack/etc. part" unless a tool result actually shows it.
- When the user asks for a specific KIND of part for a model (e.g. "a door part for model X"), call \
get_model WITH the part_type argument set to that kind (e.g. part_type:"door"). The tool returns ONLY \
matching parts. If it returns an empty parts list, tell the customer plainly that no such part is \
listed for that model - do NOT relabel an unrelated part (a gasket or control panel is not a door part).
- PRICES & STOCK: state a price or in-stock status for a part ONLY if the tool result includes it for \
that exact part. If a part has no price in the result, say the price isn't listed - NEVER invent one or \
reuse another part's price.

TOOLS - pick the right one:
- Specific PS/manufacturer number → get_part.
- "What part do I need for <problem>" / a described symptom → diagnose (or search_parts).
- "Does part X fit model Y" → check_compatibility. ONLY call this when the user gave BOTH a real part \
number AND a real model number. Never pass a placeholder like "Unknown" as the model.
- "What parts fit model Y" / "what door part for model Y" → get_model (returns the parts for that model).
- "How do I install X" → get_installation.
- Returns/warranty/shipping/contact/order-status questions → get_policy.
- Order status by number+email → lookup_order.
- You may chain tools in one turn (e.g. get_part then check_compatibility).

STYLE: concise, friendly, scannable. The UI renders rich cards for the parts you reference, so don't \
dump every field as text - summarize and call out price, stock, fit, and next steps. Mention the \
PartSelect number so the customer can find the part.`;

// ----- Widget mapping --------------------------------------------------------
// MCP tool results use snake_case (ps_number, in_stock, ...). The frontend widgets
// (src/components/Widgets.js) expect camelCase. Map between the two here so the
// MCP contract and the UI contract stay independent.
function toWidgetPart(p) {
  if (!p) return null;
  return {
    partSelectNumber: p.ps_number || p.partSelectNumber || p.partNumber,
    manufacturerPartNumber: p.mfr_number || p.manufacturerPartNumber,
    name: p.name,
    brand: p.brand,
    appliance: p.appliance_type || p.appliance,
    category: p.category,
    price: p.price,
    inStock: p.in_stock != null ? p.in_stock : p.inStock,
    rating: p.rating,
    reviewCount: p.review_count != null ? p.review_count : p.reviewCount,
    imageUrl: p.image_url || p.imageUrl,
    description: p.description,
    // Link to the part's page on partselect.com. Live results carry a real URL;
    // offline catalog rows don't, so fall back to the search endpoint, which
    // 302s a PS number straight to its detail page.
    url:
      p.url ||
      p.sourceUrl ||
      ((p.ps_number || p.partSelectNumber)
        ? `https://www.partselect.com/api/search/?searchterm=${encodeURIComponent(p.ps_number || p.partSelectNumber)}`
        : null),
  };
}

// Turn an MCP tool result into the inline UI widget the frontend renders.
function buildWidget(name, r) {
  if (!r) return null;
  switch (name) {
    case "search_parts": {
      const parts = (r.parts || []).map(toWidgetPart);
      return parts.length ? { type: "product_list", parts } : null;
    }
    case "diagnose": {
      const parts = (r.candidate_parts || r.parts || []).map(toWidgetPart);
      return parts.length ? { type: "product_list", title: "Likely fixes", parts } : null;
    }
    case "get_part": {
      if (!r.found || !r.part) return null;
      return { type: "product_card", part: toWidgetPart(r.part) };
    }
    case "get_model": {
      const parts = (r.parts || []).map(toWidgetPart);
      return r.found && parts.length
        ? { type: "product_list", title: `Parts for model ${r.model_number}`, parts }
        : null;
    }
    case "get_installation": {
      if (!r.found) return null;
      return {
        type: "install_guide",
        partName: r.part_name,
        partNumber: r.part_number,
        difficulty: r.difficulty,
        estimatedTimeMins: r.time_mins,
        estimatedTime: r.time,
        tools: r.tools || [],
        steps: r.steps || [],
        videoUrl: r.video_url,
      };
    }
    case "check_compatibility": {
      if (!r.found) return null;
      return {
        type: "compatibility",
        // Live mode reports compatible: true | false | null (unverified). Only
        // render a green "Compatible" badge on an explicit true.
        compatible: r.compatible === true,
        partNumber: r.part_number,
        partName: r.part_name,
        modelNumber: r.model_number,
        part: r.part ? toWidgetPart(r.part) : null,
      };
    }
    default:
      return null; // get_policy, lookup_order: text-only, no widget.
  }
}

// ----- Local cart (session state the MCP server doesn't own) -----------------
const carts = new Map();
const getCart = (sessionId) => {
  if (!carts.has(sessionId)) carts.set(sessionId, []);
  return carts.get(sessionId);
};
const cartSummary = (cart) => {
  const items = cart.map((i) => ({ ...i, lineTotal: +(i.price * i.quantity).toFixed(2) }));
  const total = +items.reduce((s, i) => s + i.lineTotal, 0).toFixed(2);
  const itemCount = items.reduce((s, i) => s + i.quantity, 0);
  return { items, itemCount, total };
};

async function addToCart(args, sessionId) {
  const r = await mcp.callTool("get_part", { part_number: args.partNumber });
  if (!r.found || !r.part) return { result: { added: false, message: `No part found for ${args.partNumber}.` } };
  const p = toWidgetPart(r.part);
  // Block only on a known-out-of-stock; treat unknown stock (null) as orderable.
  if (p.inStock === false) return { result: { added: false, message: `${p.name} (${p.partSelectNumber}) is out of stock.` } };
  const qty = Math.max(1, parseInt(args.quantity, 10) || 1);
  const cart = getCart(sessionId);
  const existing = cart.find((i) => i.partSelectNumber === p.partSelectNumber);
  if (existing) existing.quantity += qty;
  else cart.push({ partSelectNumber: p.partSelectNumber, name: p.name, price: p.price, quantity: qty, imageUrl: p.imageUrl });
  return { result: { added: true, cart: cartSummary(cart) }, _widget: { type: "cart", ...cartSummary(cart) } };
}

// Local cart tool specs, advertised to the model alongside the MCP tools.
const CART_TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "add_to_cart",
      description: "Add a part to the user's cart by part number and quantity.",
      parameters: {
        type: "object",
        properties: { partNumber: { type: "string" }, quantity: { type: "integer", minimum: 1, default: 1 } },
        required: ["partNumber"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_cart",
      description: "View the current contents and total of the user's cart.",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ----- Unified tool runner (MCP data tools + local cart tools) ---------------
// Returns { result, _widget? } just like the old in-process handlers, so the
// agent loop is agnostic to where a tool runs.
async function runTool(name, args, sessionId) {
  if (name === "add_to_cart") return addToCart(args, sessionId);
  if (name === "view_cart") {
    const cart = getCart(sessionId);
    return { result: cartSummary(cart), _widget: { type: "cart", ...cartSummary(cart) } };
  }
  const result = await mcp.callTool(name, args);
  return { result, _widget: buildWidget(name, result) };
}

// Cache the tool spec list (MCP tools + cart tools) for the Ollama loop.
let _ollamaToolsPromise = null;
async function getOllamaTools() {
  if (!_ollamaToolsPromise) {
    _ollamaToolsPromise = mcp.listOllamaTools()
      .then((mcpTools) => [...mcpTools, ...CART_TOOL_DEFS]);
    _ollamaToolsPromise.catch(() => { _ollamaToolsPromise = null; });
  }
  return _ollamaToolsPromise;
}

// ----- Ollama-backed agent loop ---------------------------------------------
async function ollamaChat(convo, tools) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: convo,
      tools,
      stream: false,
      // qwen3 is a reasoning model; disable thinking for low-latency support replies.
      think: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama responded ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.message; // { role, content, tool_calls? }
}

async function runOllamaAgent(messages) {
  const widgets = [];
  const tools = await getOllamaTools();
  // System prompt first, then the user/assistant history.
  const convo = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const msg = await ollamaChat(convo, tools);
    const toolCalls = msg.tool_calls || [];
    // Record the assistant turn (text + any tool_calls).
    convo.push(msg);

    if (toolCalls.length === 0) {
      const text = (msg.content || "").trim();
      return { content: text || "How can I help with your refrigerator or dishwasher parts?", widgets };
    }

    // Run each requested tool and feed results back as `tool` messages.
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      // Ollama returns arguments as an object; tolerate a JSON string too.
      let args = tc.function?.arguments || {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      const out = await runTool(name, args, "default");
      if (out._widget) widgets.push(out._widget);
      convo.push({
        role: "tool",
        tool_name: name,
        content: JSON.stringify(out.result),
      });
    }
  }

  return {
    content: "I wasn't able to fully resolve that. Could you rephrase or give a part or model number?",
    widgets,
  };
}

// ----- Remote OpenAI-compatible agent (vLLM / Gemini) ------------------------
// Same agentic loop as Ollama, but speaks the OpenAI /chat/completions wire
// format: tool results are echoed back as `tool` messages keyed by tool_call_id.
async function openaiChat(convo, tools) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(LLM_API_KEY ? { Authorization: `Bearer ${LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: convo,
      tools,
      tool_choice: "auto",
      stream: false,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${LLM_PROVIDER} responded ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message; // { role, content, tool_calls? }
}

async function runRemoteAgent(messages) {
  const widgets = [];
  const tools = await getOllamaTools(); // OpenAI function-tool format; shared.
  const convo = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content })),
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const msg = await openaiChat(convo, tools);
    if (!msg) throw new Error(`${LLM_PROVIDER} returned no message`);
    const toolCalls = msg.tool_calls || [];
    convo.push(msg);

    if (toolCalls.length === 0) {
      const text = (msg.content || "").trim();
      return { content: text || "How can I help with your refrigerator or dishwasher parts?", widgets };
    }

    for (const tc of toolCalls) {
      const name = tc.function?.name;
      let args = tc.function?.arguments || {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      const out = await runTool(name, args, "default");
      if (out._widget) widgets.push(out._widget);
      convo.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(out.result) });
    }
  }

  return {
    content: "I wasn't able to fully resolve that. Could you rephrase or give a part or model number?",
    widgets,
  };
}

app.post("/api/chat", async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) return res.status(400).json({ error: "messages required" });

    const result = IS_REMOTE ? await runRemoteAgent(messages) : await runOllamaAgent(messages);
    res.json({ role: "assistant", content: result.content, widgets: result.widgets || [] });
  } catch (err) {
    console.error("chat error:", err);
    res.status(500).json({
      role: "assistant",
      content: "Sorry, I hit an error reaching the parts service. Please try again.",
      widgets: [],
    });
  }
});

app.get("/api/health", (req, res) =>
  res.json(
    IS_REMOTE
      ? { ok: true, mode: `${LLM_PROVIDER}+mcp`, provider: LLM_PROVIDER, model: LLM_MODEL, baseUrl: LLM_BASE_URL, keyed: !!LLM_API_KEY, data: mcp.DATA_MODE }
      : { ok: true, mode: "ollama+mcp", provider: "ollama", model: MODEL, host: OLLAMA_HOST, data: mcp.DATA_MODE }
  )
);

app.listen(PORT, () => {
  const backend = IS_REMOTE
    ? `${LLM_PROVIDER} ${LLM_MODEL} @ ${LLM_BASE_URL}`
    : `Ollama ${MODEL} @ ${OLLAMA_HOST}`;
  console.log(`PartSelect agent on :${PORT} (${backend}, MCP data: ${mcp.DATA_MODE})`);
});
