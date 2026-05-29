// Agent tools: the JSON schemas advertised to Claude + the handlers that run
// when Claude calls them. Each handler returns a plain object that becomes the
// tool_result the model reads. Handlers also return an optional `_widget`
// payload that the backend forwards to the UI so the chat can render rich
// product cards / compatibility badges / cart views (see server/index.js).

const { PARTS } = require("./catalog");

// Tiny in-memory cart keyed by session id. Stands in for a real cart/order
// service; swap for a DB-backed store without touching the tool contract.
const carts = new Map();
const getCart = (sessionId) => {
  if (!carts.has(sessionId)) carts.set(sessionId, []);
  return carts.get(sessionId);
};

const norm = (s) => (s || "").toString().trim().toLowerCase();

const findPart = (id) => {
  const q = norm(id);
  return PARTS.find(
    (p) =>
      norm(p.partSelectNumber) === q ||
      norm(p.manufacturerPartNumber) === q
  );
};

// Public, model-facing view of a part (drops nothing sensitive here, but keeps
// the shape stable and intentional).
const partCard = (p) => ({
  partSelectNumber: p.partSelectNumber,
  manufacturerPartNumber: p.manufacturerPartNumber,
  name: p.name,
  brand: p.brand,
  appliance: p.appliance,
  category: p.category,
  price: p.price,
  inStock: p.inStock,
  rating: p.rating,
  reviewCount: p.reviewCount,
  imageUrl: p.imageUrl,
  description: p.description,
});

// ---------------------------------------------------------------- tool specs
const toolDefs = [
  {
    name: "search_parts",
    description:
      "Search the PartSelect catalog for refrigerator or dishwasher parts by " +
      "free-text query, symptom, brand, category, or appliance type. Use this " +
      "when the user describes a problem or asks what part they need, rather " +
      "than giving an exact part number.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search terms or symptom, e.g. 'ice maker not working'." },
        appliance: { type: "string", enum: ["Refrigerator", "Dishwasher"], description: "Optional appliance filter." },
        brand: { type: "string", description: "Optional brand filter, e.g. 'Whirlpool'." },
      },
      required: ["query"],
    },
  },
  {
    name: "get_part_details",
    description:
      "Get full details for a single part by its PartSelect number (PS…) or " +
      "manufacturer part number. Use when the user references a specific part number.",
    input_schema: {
      type: "object",
      properties: {
        partNumber: { type: "string", description: "PartSelect number (e.g. PS11752778) or manufacturer number." },
      },
      required: ["partNumber"],
    },
  },
  {
    name: "check_compatibility",
    description:
      "Check whether a specific part fits a specific appliance model number. " +
      "Use for questions like 'Is this part compatible with my WDT780SAEM1 model?'.",
    input_schema: {
      type: "object",
      properties: {
        partNumber: { type: "string", description: "Part number to check." },
        modelNumber: { type: "string", description: "Appliance model number, e.g. WDT780SAEM1." },
      },
      required: ["partNumber", "modelNumber"],
    },
  },
  {
    name: "get_installation_guide",
    description:
      "Get step-by-step installation instructions, difficulty, estimated time, " +
      "and an install video for a part. Use for 'how do I install part X' questions.",
    input_schema: {
      type: "object",
      properties: {
        partNumber: { type: "string", description: "Part number to install." },
      },
      required: ["partNumber"],
    },
  },
  {
    name: "diagnose_symptom",
    description:
      "Given a described symptom and optionally the appliance type and model, " +
      "return likely-cause parts and repair guidance. Use for troubleshooting " +
      "questions like 'the ice maker on my fridge is not working'.",
    input_schema: {
      type: "object",
      properties: {
        symptom: { type: "string", description: "The problem the user described." },
        appliance: { type: "string", enum: ["Refrigerator", "Dishwasher"] },
        modelNumber: { type: "string", description: "Optional model number to filter compatible fixes." },
      },
      required: ["symptom"],
    },
  },
  {
    name: "add_to_cart",
    description: "Add a part to the user's cart by part number and quantity.",
    input_schema: {
      type: "object",
      properties: {
        partNumber: { type: "string" },
        quantity: { type: "integer", minimum: 1, default: 1 },
      },
      required: ["partNumber"],
    },
  },
  {
    name: "view_cart",
    description: "View the current contents and total of the user's cart.",
    input_schema: { type: "object", properties: {} },
  },
];

// --------------------------------------------------------------- tool runners
function runTool(name, input, sessionId) {
  switch (name) {
    case "search_parts": {
      const q = norm(input.query);
      const terms = q.split(/\s+/).filter(Boolean);
      let results = PARTS.filter((p) => {
        if (input.appliance && norm(p.appliance) !== norm(input.appliance)) return false;
        if (input.brand && norm(p.brand) !== norm(input.brand)) return false;
        const hay = norm(
          [p.name, p.category, p.description, p.brand, p.appliance, ...(p.symptoms || [])].join(" ")
        );
        return terms.some((t) => hay.includes(t));
      });
      // Rank by how many query terms match.
      results.sort((a, b) => score(b, terms) - score(a, terms));
      results = results.slice(0, 5);
      return {
        result: {
          count: results.length,
          parts: results.map(partCard),
        },
        _widget: results.length
          ? { type: "product_list", parts: results.map(partCard) }
          : null,
      };
    }

    case "get_part_details": {
      const p = findPart(input.partNumber);
      if (!p) return { result: { found: false, message: `No part found for ${input.partNumber}.` } };
      return {
        result: { found: true, part: { ...partCard(p), symptoms: p.symptoms, difficulty: p.difficulty, installTimeMins: p.installTimeMins } },
        _widget: { type: "product_card", part: partCard(p) },
      };
    }

    case "check_compatibility": {
      const p = findPart(input.partNumber);
      if (!p) return { result: { found: false, message: `No part found for ${input.partNumber}.` } };
      const model = norm(input.modelNumber);
      const compatible = p.compatibleModels.some((m) => norm(m) === model);
      return {
        result: {
          found: true,
          partNumber: p.partSelectNumber,
          partName: p.name,
          modelNumber: input.modelNumber,
          compatible,
          // If not in our list we say so honestly rather than guessing.
          note: compatible
            ? "Confirmed compatible."
            : "This model is not in our verified-fit list for this part. Advise the customer to confirm via the model's parts page before ordering.",
        },
        _widget: {
          type: "compatibility",
          compatible,
          partNumber: p.partSelectNumber,
          partName: p.name,
          modelNumber: input.modelNumber,
          part: partCard(p),
        },
      };
    }

    case "get_installation_guide": {
      const p = findPart(input.partNumber);
      if (!p) return { result: { found: false, message: `No part found for ${input.partNumber}.` } };
      return {
        result: {
          found: true,
          partNumber: p.partSelectNumber,
          partName: p.name,
          difficulty: p.difficulty,
          estimatedTimeMins: p.installTimeMins,
          steps: p.installSteps,
          videoUrl: p.installVideoUrl,
        },
        _widget: {
          type: "install_guide",
          partName: p.name,
          partNumber: p.partSelectNumber,
          difficulty: p.difficulty,
          estimatedTimeMins: p.installTimeMins,
          steps: p.installSteps,
          videoUrl: p.installVideoUrl,
        },
      };
    }

    case "diagnose_symptom": {
      const terms = norm(input.symptom).split(/\s+/).filter(Boolean);
      const model = norm(input.modelNumber);
      let matches = PARTS.filter((p) => {
        if (input.appliance && norm(p.appliance) !== norm(input.appliance)) return false;
        if (model && !p.compatibleModels.some((m) => norm(m) === model)) return false;
        const hay = norm((p.symptoms || []).join(" ") + " " + p.description);
        return terms.some((t) => t.length > 2 && hay.includes(t));
      });
      matches.sort((a, b) => symptomScore(b, terms) - symptomScore(a, terms));
      matches = matches.slice(0, 4);
      return {
        result: {
          count: matches.length,
          likelyParts: matches.map((p) => ({
            ...partCard(p),
            matchedSymptoms: (p.symptoms || []).filter((s) =>
              terms.some((t) => norm(s).includes(t))
            ),
          })),
        },
        _widget: matches.length
          ? { type: "product_list", title: "Likely fixes", parts: matches.map(partCard) }
          : null,
      };
    }

    case "add_to_cart": {
      const p = findPart(input.partNumber);
      if (!p) return { result: { added: false, message: `No part found for ${input.partNumber}.` } };
      if (!p.inStock) return { result: { added: false, message: `${p.name} (${p.partSelectNumber}) is out of stock.` } };
      const qty = Math.max(1, parseInt(input.quantity, 10) || 1);
      const cart = getCart(sessionId);
      const existing = cart.find((i) => i.partSelectNumber === p.partSelectNumber);
      if (existing) existing.quantity += qty;
      else cart.push({ partSelectNumber: p.partSelectNumber, name: p.name, price: p.price, quantity: qty, imageUrl: p.imageUrl });
      return { result: { added: true, cart: cartSummary(cart) }, _widget: { type: "cart", ...cartSummary(cart) } };
    }

    case "view_cart": {
      const cart = getCart(sessionId);
      return { result: cartSummary(cart), _widget: { type: "cart", ...cartSummary(cart) } };
    }

    default:
      return { result: { error: `Unknown tool: ${name}` } };
  }
}

const score = (p, terms) => {
  const hay = norm([p.name, p.category, p.description, ...(p.symptoms || [])].join(" "));
  return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
};
const symptomScore = (p, terms) => {
  const hay = norm((p.symptoms || []).join(" "));
  return terms.reduce((n, t) => n + (t.length > 2 && hay.includes(t) ? 1 : 0), 0);
};
const cartSummary = (cart) => {
  const items = cart.map((i) => ({ ...i, lineTotal: +(i.price * i.quantity).toFixed(2) }));
  const total = +items.reduce((s, i) => s + i.lineTotal, 0).toFixed(2);
  const itemCount = items.reduce((s, i) => s + i.quantity, 0);
  return { items, itemCount, total };
};

module.exports = { toolDefs, runTool };
