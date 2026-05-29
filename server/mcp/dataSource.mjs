// Unified data layer for the MCP server.
//
// One contract, two backends:
//   - offline : the mock catalog in server/catalog.js (fast, deterministic, demo-safe)
//   - live    : the scraper in server/scraper.js (real partselect.com via fetch/Playwright)
//   - auto    : try live, fall back to offline on error / empty
//
// Pick with PARTSELECT_DATA = offline | live | auto   (default: offline).
//
// Every function returns the same JSON shape regardless of backend, so the MCP
// tool handlers (server/mcp/index.mjs) never branch on the source.

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { PARTS } = require("../catalog.js");
const scraper = require("../scraper.js");

const MODE = (process.env.PARTSELECT_DATA || "offline").toLowerCase();
const norm = (s) => (s || "").toString().trim().toLowerCase();

// Live search / model pages list parts thin - just ps_number, name, url. Enrich
// the top N with a full part fetch so callers get price, stock, brand, rating,
// and image (the fields the UI cards and the agent actually need). Capped to
// bound latency; the scraper throttles + caches, so repeats are cheap.
const ENRICH_LIMIT = Number(process.env.PARTSELECT_ENRICH || 5);

async function enrichParts(parts, cap = ENRICH_LIMIT) {
  if (!Array.isArray(parts) || !parts.length) return parts || [];
  const head = await Promise.all(
    parts.slice(0, cap).map(async (p) => {
      if (!p.ps_number) return p;
      try {
        const full = await scraper.getPart(p.ps_number);
        if (full && full.found) {
          return {
            ...p,
            name: full.name || p.name,
            mfr_number: full.mfr_number ?? p.mfr_number,
            brand: full.brand ?? p.brand,
            appliance_type: full.appliance_type ?? p.appliance_type,
            price: full.price ?? p.price,
            in_stock: full.inStock ?? p.in_stock,
            rating: full.rating ?? p.rating,
            review_count: full.review_count ?? p.review_count,
            image_url: full.imageUrl ?? p.image_url,
            description: full.description ?? p.description,
            url: p.url || full.sourceUrl,
          };
        }
      } catch {
        /* keep the thin part on any fetch/parse error */
      }
      return p;
    })
  );
  return [...head, ...parts.slice(cap)];
}

// ----------------------------------------------------------- normalization
// Map a mock-catalog record (catalog.js) into the unified MCP shape so offline
// and live responses look identical to the agent.
function fromCatalog(p) {
  if (!p) return null;
  return {
    ps_number: p.partSelectNumber,
    mfr_number: p.manufacturerPartNumber,
    name: p.name,
    brand: p.brand,
    appliance_type: p.appliance,
    category: p.category,
    price: p.price,
    in_stock: p.inStock,
    rating: p.rating,
    review_count: p.reviewCount,
    image_url: p.imageUrl,
    description: p.description,
    symptoms_fixed: p.symptoms || [],
    compatible_models: p.compatibleModels || [],
    install: {
      difficulty: p.difficulty,
      time_mins: p.installTimeMins,
      steps: p.installSteps || [],
      video_url: p.installVideoUrl,
    },
    source: "catalog",
  };
}

const findCatalog = (id) => {
  const q = norm(id);
  return PARTS.find(
    (p) => norm(p.partSelectNumber) === q || norm(p.manufacturerPartNumber) === q
  );
};

// ----------------------------------------------------------- search_parts
export async function searchParts({ query, appliance, brand, limit = 5 }) {
  if (MODE === "live" || MODE === "auto") {
    try {
      const live = await scraper.searchParts(query, { limit });
      if (live.count) {
        const parts = await enrichParts(live.parts);
        return { count: parts.length, parts, source: "live" };
      }
      if (MODE === "live") return { count: 0, parts: [], source: "live", note: live.error };
    } catch (e) {
      if (MODE === "live") return { count: 0, parts: [], source: "live", error: e.message };
      // auto → fall through to offline
    }
  }

  const terms = norm(query).split(/\s+/).filter(Boolean);
  const scored = PARTS.filter((p) => {
    if (appliance && norm(p.appliance) !== norm(appliance)) return false;
    if (brand && norm(p.brand) !== norm(brand)) return false;
    const hay = norm(
      [p.name, p.category, p.description, p.brand, p.appliance, ...(p.symptoms || [])].join(" ")
    );
    return terms.some((t) => hay.includes(t));
  });
  const score = (p) => {
    const hay = norm([p.name, p.category, p.description, ...(p.symptoms || [])].join(" "));
    return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
  };
  scored.sort((a, b) => score(b) - score(a));
  const parts = scored.slice(0, limit).map(fromCatalog);
  return { count: parts.length, parts, source: "catalog" };
}

// ----------------------------------------------------------- get_part
export async function getPart({ part_number }) {
  if (MODE === "live" || MODE === "auto") {
    try {
      const live = await scraper.getPart(part_number);
      if (live.found) return { found: true, part: { ...live, source: "live" } };
      if (MODE === "live") return { found: false, message: live.message };
    } catch (e) {
      if (MODE === "live") return { found: false, error: e.message };
    }
  }
  const p = findCatalog(part_number);
  if (!p) return { found: false, message: `No part found for ${part_number}.` };
  return { found: true, part: fromCatalog(p) };
}

// ----------------------------------------------------------- check_compatibility
export async function checkCompatibility({ part_number, model_number }) {
  if (MODE === "live" || MODE === "auto") {
    try {
      const live = await scraper.checkCompatibility(part_number, model_number);
      if (live.found) return { ...live, source: "live" };
      if (MODE === "live") return live;
    } catch (e) {
      if (MODE === "live") return { found: false, compatible: false, error: e.message };
    }
  }
  const p = findCatalog(part_number);
  if (!p) return { found: false, compatible: false, message: `No part found for ${part_number}.` };
  const compatible = (p.compatibleModels || []).some((m) => norm(m) === norm(model_number));
  return {
    found: true,
    compatible,
    part_number: p.partSelectNumber,
    part_name: p.name,
    model_number,
    appliance_type_match: true,
    reason: compatible
      ? "Listed in this part's verified-fit model list."
      : "Not in our verified-fit list for this part. Confirm on the model's parts page before ordering.",
    source: "catalog",
  };
}

// ----------------------------------------------------------- get_model
// `part_type` (optional) filters the model's parts to those whose name matches a
// requested kind ("door", "drain pump", ...). Filtering happens at the data layer
// so the agent can't mislabel an unrelated part - if nothing matches, the result
// is an empty parts list, not a relabeled guess.
const matchesType = (name, type) => !type || norm(name).includes(norm(type));

export async function getModel({ model_number, part_type }) {
  if (MODE === "live" || MODE === "auto") {
    try {
      const live = await scraper.getModel(model_number);
      if (live.found) {
        const filtered = (live.parts || []).filter((p) => matchesType(p.name, part_type));
        // Enrich the full filtered set (small) so every shown part has a real
        // price/stock; cap the unfiltered list to bound latency.
        const parts = await enrichParts(filtered, part_type ? Math.min(filtered.length, 12) : ENRICH_LIMIT);
        return { ...live, parts, part_type: part_type || null, source: "live" };
      }
      if (MODE === "live") return live;
    } catch (e) {
      if (MODE === "live") return { found: false, error: e.message };
    }
  }
  // Offline: derive the model record from which catalog parts list it.
  const mn = norm(model_number);
  const all = PARTS.filter((p) => (p.compatibleModels || []).some((m) => norm(m) === mn));
  if (!all.length) {
    return { found: false, model_number, message: `No catalog parts reference model ${model_number}.` };
  }
  const parts = all.filter((p) => matchesType(`${p.name} ${p.category}`, part_type));
  return {
    found: true,
    model_number: model_number.toUpperCase(),
    brand: all[0].brand,
    appliance_type: all[0].appliance,
    part_type: part_type || null,
    parts: parts.map((p) => fromCatalog(p)),
    source: "catalog",
  };
}

// ----------------------------------------------------------- diagnose
export async function diagnose({ symptom, appliance_type, model_number }) {
  // Symptom matching lives in the curated catalog (real symptom→part mapping);
  // the live scraper isn't a diagnosis engine, so diagnose always
  // reasons over the catalog. Live lookups confirm price/stock afterward.
  const terms = norm(symptom).split(/\s+/).filter((t) => t.length > 2);
  const mn = norm(model_number);
  // Symptom + appliance match is the core of a diagnosis.
  const base = PARTS.filter((p) => {
    if (appliance_type && norm(p.appliance) !== norm(appliance_type)) return false;
    const hay = norm((p.symptoms || []).join(" ") + " " + p.description);
    return terms.some((t) => hay.includes(t));
  });
  // model_number is an OPTIONAL narrowing, not a gate. The model fit list often
  // narrows to a real model, but callers also pass junk here (a brand like
  // "Whirlpool", "fridge", or a model we don't list). So apply it as a soft
  // filter: keep the model-fitting subset only if it's non-empty, otherwise fall
  // back to the full symptom match. A symptom diagnosis should never come back
  // empty just because a model arg didn't line up.
  let matches = base;
  if (mn) {
    const fit = base.filter((p) => (p.compatibleModels || []).some((m) => norm(m) === mn));
    if (fit.length) matches = fit;
  }
  const symScore = (p) => {
    const hay = norm((p.symptoms || []).join(" "));
    return terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
  };
  matches = [...matches].sort((a, b) => symScore(b) - symScore(a)).slice(0, 4);
  return {
    count: matches.length,
    symptom,
    candidate_parts: matches.map((p) => ({
      ...fromCatalog(p),
      matched_symptoms: (p.symptoms || []).filter((s) => terms.some((t) => norm(s).includes(t))),
    })),
    call_pro_if:
      "Basic checks don't help, or the fault points to electrical, pump, or control-board failure.",
    source: "catalog",
  };
}

// ----------------------------------------------------------- get_installation
export async function getInstallation({ part_number }) {
  const r = await getPart({ part_number });
  if (!r.found) return r;
  const p = r.part;
  const inst = p.install || {};
  return {
    found: true,
    part_number: p.ps_number,
    part_name: p.name,
    difficulty: inst.difficulty || p.install_difficulty || null,
    time_mins: inst.time_mins || null,
    time: p.install_time || (inst.time_mins ? `${inst.time_mins} mins` : null),
    tools: p.install_tools || inst.tools || [],
    steps: inst.steps && inst.steps.length ? inst.steps : null,
    video_url: inst.video_url || p.install_video_url || null,
    source: p.source || "catalog",
  };
}

// ----------------------------------------------------------- get_policy
// Static + stable; no fetch needed.
const POLICIES = {
  returns: {
    text:
      "365-day returns: returns must be received within 365 days of the original ship " +
      "date. Full refund if the part is in resalable condition (no signs of " +
      "installation, scuffs, or damage). The customer pays return shipping unless the " +
      "return is due to a PartSelect error or the part was lost in shipping - in that " +
      "case contact within 10 business days for a prepaid label and shipping refund. " +
      "Start a return via the Self-Service portal with your order number + email.",
    links: ["https://www.partselect.com/365-Day-Returns.htm"],
  },
  warranty: {
    text: "All OEM parts carry a one-year manufacturer's warranty.",
    links: ["https://www.partselect.com/one-year-warranty.htm"],
  },
  shipping: {
    text:
      "700,000+ parts ship the same day (Order Today, Ships Today). You receive an " +
      "order confirmation email with an order number, then a shipment confirmation " +
      "email with a tracking number when it ships.",
    links: ["https://www.partselect.com/Help/"],
  },
  contact: {
    text: "Phone 1-866-319-8402, email CustomerService@PartSelect.com.",
    links: ["https://www.partselect.com/Contact/"],
    phone: "1-866-319-8402",
    email: "CustomerService@PartSelect.com",
  },
  order_status: {
    text:
      "Check order status, returns, and cancellations via the Self-Service portal " +
      "using your order number + email address. For live order data the agent needs an " +
      "authenticated order-lookup integration (see lookup_order).",
    links: ["https://www.partselect.com/Help/"],
  },
};

export async function getPolicy({ topic }) {
  const p = POLICIES[topic];
  if (!p) return { found: false, message: `Unknown policy topic '${topic}'.`, topics: Object.keys(POLICIES) };
  return { found: true, topic, ...p };
}

// ----------------------------------------------------------- lookup_order (stub)
// Real order status needs an authenticated PartSelect order API. Stubbed here so
// the tool contract exists; never fabricate order data.
export async function lookupOrder({ order_number, email }) {
  return {
    available: false,
    message:
      "Live order lookup requires an authenticated PartSelect order integration, " +
      "which isn't connected in this demo. Direct the customer to the Self-Service " +
      "portal with their order number + email, or to 1-866-319-8402.",
    order_number: order_number || null,
    email: email || null,
  };
}

export const dataMode = () => MODE;
export { scraper };
