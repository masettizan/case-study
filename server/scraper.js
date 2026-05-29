// PartSelect live scraper - turns a part number OR model number into a
// structured record matching the catalog.js field shape, so it drops into the
// MCP data layer as the `live` backend without touching the tool contract.
//
// partselect.com has no public API but predictable URLs, so we build them,
// fetch the HTML, and parse the fields we need. The site 403s plain server
// fetches, so fetching is layered: plain fetch() with browser headers first,
// then Playwright (optional dep) to bypass the 403. Parsing falls back from
// cheerio to regex if cheerio isn't installed.
//
// Optional deps:
//   npm i cheerio                                          # robust HTML parsing
//   npm i playwright && npx playwright install chromium    # 403 bypass
//
// CLI:
//   node server/scraper.js PS11752778
//   node server/scraper.js WPW10321304
//   node server/scraper.js --model WDT780SAEM1
//   node server/scraper.js --compat PS11756150 WDT780SAEM1
//   node server/scraper.js --search "ice maker not working"

"use strict";

const BASE = "https://www.partselect.com";

// Realistic browser headers - plain Node fetch with default headers gets 403.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif," +
    "image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
};

// --------------------------------------------------------------- tiny TTL cache
// Part/model pages change slowly; cache to avoid hammering the site and to keep
// the agent fast. Prices/stock want a shorter TTL than static fields in prod.
const CACHE_TTL_MS = Number(process.env.SCRAPER_CACHE_TTL_MS || 1000 * 60 * 30);
const cache = new Map(); // key -> { at, value }

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  return null;
}
function cacheSet(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------- rate limiter
// Single in-flight gate + min gap between requests. Be a good citizen; respect
// robots/ToS and don't burst.
const MIN_REQUEST_GAP_MS = Number(process.env.SCRAPER_MIN_GAP_MS || 1200);
let lastRequestAt = 0;
let queue = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function throttle(fn) {
  // Chain on a shared promise so requests serialize with a min gap.
  const run = queue.then(async () => {
    const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fn();
  });
  // Keep the chain alive even if this request rejects.
  queue = run.then(() => {}, () => {});
  return run;
}

// ------------------------------------------------------------- fetch strategies
// Returns { html, finalUrl } or throws. finalUrl reflects redirects - the site
// 302s search queries straight to the canonical part page, so callers need it.
// Tries plain fetch first, then Playwright if present (403 bypass).
async function fetchPage(url) {
  const cached = cacheGet("page:" + url);
  if (cached) return cached;

  return throttle(async () => {
    // Re-check cache inside the gate (another caller may have filled it).
    const c = cacheGet("page:" + url);
    if (c) return c;

    let html = null;
    let finalUrl = url;
    let plainStatus = null;
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
      plainStatus = res.status;
      finalUrl = res.url || url;
      if (res.ok) html = await res.text();
    } catch (e) {
      plainStatus = `fetch error: ${e.message}`;
    }

    // 403 / block → escalate to a real browser if available.
    if (!html) {
      const pw = await fetchWithPlaywright(url, plainStatus);
      if (pw) ({ html, finalUrl } = pw);
    }
    if (!html) {
      throw new Error(
        `Could not fetch ${url} (plain fetch status: ${plainStatus}). ` +
          `partselect.com likely blocked the request. Install Playwright for a ` +
          `403 bypass:  npm i playwright && npx playwright install chromium`
      );
    }
    return cacheSet("page:" + url, { html, finalUrl });
  });
}

// Html-only convenience for callers that don't care about the redirect target.
async function fetchHtml(url) {
  return (await fetchPage(url)).html;
}

let _browserPromise = null;
async function fetchWithPlaywright(url, plainStatus) {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    return null; // optional dep not installed - caller surfaces guidance.
  }
  if (!_browserPromise) {
    _browserPromise = chromium.launch({ headless: true });
  }
  const browser = await _browserPromise;
  const ctx = await browser.newContext({ userAgent: BROWSER_HEADERS["User-Agent"] });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return { html: await page.content(), finalUrl: page.url() };
  } finally {
    await ctx.close();
  }
}

// Call on process exit if you used Playwright, so the browser closes.
async function closeBrowser() {
  if (_browserPromise) {
    const b = await _browserPromise.catch(() => null);
    if (b) await b.close();
    _browserPromise = null;
  }
}

// --------------------------------------------------------------------- parsing
// cheerio if available, else a regex-based shim with the few methods we use.
function load(html) {
  try {
    const cheerio = require("cheerio");
    return { $: cheerio.load(html), engine: "cheerio" };
  } catch {
    return { $: null, engine: "regex", html };
  }
}

const clean = (s) =>
  (s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&(?:#39|apos|rsquo|lsquo);/g, "'")
    .replace(/&(?:rdquo|ldquo);/g, '"')
    // Numeric entities: &#x2019; (hex) and &#8217; (decimal).
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/\s+/g, " ")
    .trim();

const firstMatch = (html, re) => {
  const m = html.match(re);
  return m ? clean(m[1]) : null;
};

// --------------------------------------------------------------- part scraping
async function getPart(partNumber) {
  if (!partNumber) throw new Error("partNumber required");
  const key = "part:" + partNumber.trim().toUpperCase();
  const cached = cacheGet(key);
  if (cached) return cached;

  // Resolve the canonical part page, then fetch + parse it.
  const resolved = await findPartUrl(partNumber);
  if (!resolved) return cacheSet(key, { found: false, partNumber, message: `No part page found for ${partNumber}.` });

  const part = parsePart(resolved.html, resolved.url);
  part.partNumber = partNumber;
  return cacheSet(key, { found: true, ...part });
}

// Resolve a part-number/term to its canonical detail page.
// The /api/search/ endpoint 302s a PS or manufacturer number straight to the
// /PSxxxx-Brand-Mfr-Name.htm page, so the redirect target IS the answer.
// Returns { url, html } (html reused so we don't refetch the same page).
async function findPartUrl(query) {
  const searchUrl = `${BASE}/api/search/?searchterm=${encodeURIComponent(query.trim())}`;
  let page;
  try {
    page = await fetchPage(searchUrl);
  } catch {
    return null;
  }
  // Redirected straight onto a detail page - best case.
  if (/\/PS\d+-[^/?#]+\.htm/i.test(page.finalUrl)) {
    return { url: page.finalUrl.split("?")[0], html: page.html };
  }
  // Otherwise it's a results list - take the first part link.
  const m = page.html.match(/href="(\/PS\d+-[^"]+?\.htm)"/i);
  if (m) {
    const url = BASE + m[1];
    return { url, html: await fetchHtml(url) };
  }
  return null;
}

// Field markup confirmed against a live PartSelect detail page (no JSON-LD;
// the data lives in schema.org microdata: itemprop="productID"/"mpn"/"brand"/
// "price"/"ratingValue"/"reviewCount"/"availability"). cheerio is strongly
// preferred; the regex branch is a zero-dep fallback.
function parsePart(html, url) {
  const { $, engine } = load(html);

  // ps/mfr from microdata, falling back to the URL slug.
  const psNumber =
    pickAttrText($, html, "productID") ||
    (url.match(/\/(PS\d+)-/i) || [])[1];
  const mfrNumber =
    pickAttrText($, html, "mpn") ||
    (url.match(/\/PS\d+-[A-Za-z]+-([A-Z0-9]+)-/) || [])[1];

  let name, brand, price, rating, reviewCount, description, image, availability;

  if (engine === "cheerio") {
    name = clean($("h1").first().text());
    brand = clean($('[itemprop="brand"]').first().text()) || null;
    description =
      clean($('[itemprop="description"]').first().text()) ||
      clean($('meta[name="description"]').attr("content"));
    // Real product image is lazy-loaded; prefer a data-src, fall back to og:image.
    image =
      $('img[itemprop="image"]').attr("data-src") ||
      $('img[itemprop="image"]').attr("src") ||
      $('meta[property="og:image"]').attr("content") ||
      null;
    price =
      parsePrice($('[itemprop="price"]').attr("content")) ??
      parsePrice($('[itemprop="price"]').first().text());
    availability =
      clean($('[itemprop="availability"]').first().text()) ||
      ($('[itemprop="availability"]').attr("content") || "").split("/").pop() ||
      null;
    rating = parseFloat($('[itemprop="ratingValue"]').attr("content")) || null;
    reviewCount = parseInt($('[itemprop="reviewCount"]').attr("content"), 10) || null;
  } else {
    // Regex fallback (no cheerio installed).
    name = firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
    brand = pickAttrText(null, html, "brand");
    description = firstMatch(html, /<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
    image = firstMatch(html, /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    price = parsePrice((html.match(/itemprop="price"[^>]*content="([^"]+)"/i) || [])[1]);
    availability = firstMatch(html, /itemprop="availability"[^>]*>\s*([^<]+)/i);
    rating = parseFloat((html.match(/itemprop="ratingValue"[^>]*content="([^"]+)"/i) || [])[1]) || null;
    reviewCount = parseInt((html.match(/itemprop="reviewCount"[^>]*content="([^"]+)"/i) || [])[1], 10) || null;
  }

  // Strip a trailing manufacturer number the H1 sometimes appends.
  if (name && mfrNumber) name = name.replace(new RegExp("\\s*" + mfrNumber + "\\s*$", "i"), "").trim();

  // Difficulty: the label sits in a <p class="bold"> right after the difficulty icon.
  const difficulty = firstMatch(html, /difficulty"[\s\S]{0,80}?<p[^>]*class="[^"]*bold[^"]*"[^>]*>([^<]+?)(?:&nbsp;)?<\/p>/i);
  // Repair time: "Total Repair Time:</div> Less than 15 mins </div>".
  const repairTime = firstMatch(html, /Total Repair Time:\s*<\/div>\s*([^<]+?)\s*<\/div>/i);
  // Install video: lazy YouTube player carries the id in data-yt-init.
  const ytId = (html.match(/data-yt-init="([A-Za-z0-9_-]{6,})"/i) || [])[1];

  const models = extractModels(html);

  return {
    ps_number: psNumber || null,
    mfr_number: mfrNumber || null,
    name: name || null,
    brand: brand || null,
    appliance_type: guessAppliance(name, description, url),
    price,
    availability: availability || null,
    inStock: availability ? /in\s*stock/i.test(availability) : null,
    rating,
    review_count: reviewCount,
    description: description || null,
    imageUrl: image || null,
    install_difficulty: difficulty || null,
    install_time: repairTime || null,
    install_tools: extractTools(html),
    install_video_url: ytId ? `https://www.youtube.com/watch?v=${ytId}` : null,
    symptoms_fixed: extractList(html, /fixes the following symptoms?:?\s*<\/div>([\s\S]*?)<\/ul>/i),
    works_with_products: extractList(html, /works with the following products:?\s*<\/div>([\s\S]*?)<\/ul>/i),
    compatible_brands: extractBrands(html),
    compatible_models: models.models,
    compatible_models_detail: models.pairs,
    replaces_part_numbers: extractReplaces(html),
    sourceUrl: url,
  };
}

// Read text/content for an itemprop, cheerio first then regex.
function pickAttrText($, html, prop) {
  if ($) {
    const el = $(`[itemprop="${prop}"]`).first();
    return clean(el.text()) || el.attr("content") || null;
  }
  const m = html.match(new RegExp(`itemprop="${prop}"[^>]*>([^<]+)<`, "i"));
  if (m) return clean(m[1]);
  const c = html.match(new RegExp(`itemprop="${prop}"[^>]*content="([^"]+)"`, "i"));
  return c ? clean(c[1]) : null;
}

// -------------------------------------------------------------- model scraping
async function getModel(modelNumber) {
  if (!modelNumber) throw new Error("modelNumber required");
  const mn = modelNumber.trim().toUpperCase();
  const key = "model:" + mn;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = `${BASE}/Models/${encodeURIComponent(mn)}/`;
  let html;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    return cacheSet(key, { found: false, modelNumber: mn, message: e.message });
  }
  const model = parseModel(html, url, mn);
  return cacheSet(key, { found: !!model.brand || !!model.parts.length, modelNumber: mn, ...model });
}

function parseModel(html, url, mn) {
  const { $ } = load(html);
  const h1 = $ ? clean($("h1").first().text()) : firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const description = h1 || null;

  // H1 is "MODEL Brand Appliance - Overview" - brand is the token after the model.
  let brand = $ ? clean($('[itemprop="brand"]').first().text()) : null;
  if (!brand && description) {
    const bm = description.match(new RegExp(mn + "\\s+([A-Za-z][\\w-]+)", "i"));
    brand = bm ? bm[1] : null;
  }

  // Parts that fit this model - scan PS detail links, name from slug.
  let parts = [];
  const seen = new Set();
  for (const m of html.matchAll(/\/(PS\d+)-[A-Za-z0-9-]+?\.htm/g)) {
    if (seen.has(m[1]) || parts.length >= 100) continue;
    seen.add(m[1]);
    parts.push({ ps_number: m[1], name: nameFromSlug(m[0]), url: BASE + m[0] });
  }

  // Model-specific symptom pages.
  let symptoms = [];
  for (const m of html.matchAll(/href="([^"]*\/Symptoms\/[^"#]+)"/gi)) {
    const path = m[1];
    const slug = (path.match(/\/Symptoms\/([^/]+)/) || [])[1] || "";
    symptoms.push({ symptom: decodeURIComponent(slug).replace(/-/g, " ").trim(), url: path.startsWith("http") ? path : BASE + path });
  }

  return {
    model_number: mn,
    brand: brand || null,
    appliance_type: guessAppliance(description, "", url),
    description: description || null,
    parts,
    symptoms: dedupeBy(symptoms, (s) => s.url),
    sourceUrl: url,
  };
}

// --------------------------------------------------------- compatibility check
// Two signals, in order of authority:
//   1. ?ModelNum= fit badge on the part page - definitive, but
//      rendered client-side, so only readable with Playwright.
//   2. the model's parts index - confirms a fit, but cannot disprove one.
// We never assert "incompatible" from a static crawl; unknown stays unknown.
async function checkCompatibility(partNumber, modelNumber) {
  const part = await getPart(partNumber);
  if (!part.found) return { found: false, compatible: null, message: part.message };

  const mn = modelNumber.trim().toUpperCase();

  // The definitive fit verdict on the part page is rendered client-side via
  // ?ModelNum= (not in static HTML). We read it only when Playwright is present;
  // otherwise we fall back to the model's parts index, which can confirm a fit
  // but cannot rule one out (it lists only featured parts). So we never assert
  // "incompatible" from a static crawl - we say "unverified" and tell the agent
  // how to confirm. Honesty over a confident guess.
  let badge = null; // true | false | null(unknown)
  try {
    const fitUrl = `${part.sourceUrl}?ModelNum=${encodeURIComponent(mn)}`;
    const pw = await fetchWithPlaywright(fitUrl, null); // null unless Playwright installed
    if (pw && pw.html) {
      if (new RegExp(`fits your ${mn}`, "i").test(pw.html) || /this part is compatible|is a correct fit/i.test(pw.html)) badge = true;
      else if (/not compatible|does not fit|isn.t compatible/i.test(pw.html)) badge = false;
    }
  } catch {
    /* Playwright not available or page error - fall through to index. */
  }

  // Model Cross Reference on the part page lists models this part fits, in
  // static HTML - a server-readable fit signal (no Playwright needed). A match
  // is strong positive evidence; absence isn't proof (the list lazy-loads more).
  const inCrossRef = Array.isArray(part.compatible_models)
    ? part.compatible_models.includes(mn)
    : false;

  // Model parts index: a listing is strong positive evidence; absence is not
  // proof of incompatibility (index is a featured subset).
  let inModelIndex = null;
  try {
    const model = await getModel(mn);
    if (model.found) inModelIndex = model.parts.some((p) => p.ps_number === part.ps_number);
  } catch {
    /* ignore */
  }

  let compatible, confidence, reason;
  if (badge === true || inCrossRef || inModelIndex === true) {
    compatible = true;
    confidence = badge === true ? "high" : inCrossRef ? "high" : "medium";
    reason = badge === true
      ? `Site fit badge confirms it fits ${mn}.`
      : inCrossRef
        ? `Listed in this part's Model Cross Reference for ${mn}.`
        : `Listed among parts for model ${mn}.`;
  } else if (badge === false) {
    compatible = false;
    confidence = "high";
    reason = `Site fit badge reports it does not fit ${mn}.`;
  } else {
    compatible = null; // unverified - do NOT claim incompatible
    confidence = "unverified";
    reason =
      `Could not confirm fit from a static crawl (the verdict is rendered client-side). ` +
      `Install Playwright for a definitive check, or confirm on ${part.sourceUrl}?ModelNum=${mn}.`;
  }

  return {
    found: true,
    compatible,
    confidence,
    part_number: part.ps_number,
    part_name: part.name,
    model_number: mn,
    appliance_type_match: !!part.appliance_type,
    reason,
  };
}

// ------------------------------------------------------------------- search
async function searchParts(query, { limit = 5 } = {}) {
  const url = `${BASE}/api/search/?searchterm=${encodeURIComponent(query.trim())}`;
  let page, html;
  try {
    page = await fetchPage(url);
    html = page.html;
  } catch (e) {
    return { count: 0, parts: [], error: e.message };
  }
  // A direct redirect to a detail page = single exact match.
  if (/\/PS\d+-[^/?#]+\.htm/i.test(page.finalUrl)) {
    const ps = (page.finalUrl.match(/(PS\d+)/) || [])[1];
    const name = clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
    return { count: 1, parts: [{ ps_number: ps, name, url: page.finalUrl.split("?")[0] }] };
  }
  // Result links vary in inner markup, so just collect distinct part URLs and
  // derive the name from the slug (reliable, render-independent).
  const results = [];
  const seen = new Set();
  for (const m of html.matchAll(/\/(PS\d+)-[A-Za-z0-9-]+?\.htm/g)) {
    const ps = m[1];
    if (seen.has(ps)) continue;
    seen.add(ps);
    results.push({ ps_number: ps, name: nameFromSlug(m[0]), url: BASE + m[0] });
    if (results.length >= limit) break;
  }
  return { count: results.length, parts: results };
}

// "/PS123-Whirlpool-W10-Refrigerator-Door-Shelf-Bin.htm" -> "Refrigerator Door Shelf Bin"
function nameFromSlug(pathOrUrl) {
  const m = pathOrUrl.match(/\/PS\d+-[A-Za-z0-9]+-[A-Za-z0-9]+-(.+?)\.htm/);
  if (!m) return "";
  return m[1].replace(/-/g, " ").trim();
}

// ------------------------------------------------------------------- helpers
function parsePrice(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function guessAppliance(...txt) {
  const s = txt.join(" ").toLowerCase();
  if (/dishwash/.test(s)) return "Dishwasher";
  if (/refrigerat|fridge|freezer|ice maker/.test(s)) return "Refrigerator";
  return null;
}
function extractList(html, sectionRe) {
  const m = html.match(sectionRe);
  if (!m) return [];
  return [...m[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((x) => clean(x[1])).filter(Boolean).slice(0, 30);
}
// "Part# WPW10546503 replaces these:</div><div ...> AP6022813, W10306646, ... </div>"
function extractReplaces(html) {
  const m = html.match(/replaces these:\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/i);
  if (!m) return [];
  return [...m[1].matchAll(/\b([A-Z0-9]{5,})\b/g)].map((x) => x[1]).slice(0, 60);
}
// Tools appear in the per-story repair instructions: <div class="bold">Tools:</div> Screw drivers
function extractTools(html) {
  const tools = new Set();
  for (const m of html.matchAll(/<div class="bold">\s*Tools:\s*<\/div>\s*([^<]+)</gi)) {
    clean(m[1])
      .split(/,|\band\b/i)
      .map((t) => t.trim())
      .filter(Boolean)
      .forEach((t) => tools.add(t));
  }
  return [...tools].slice(0, 20);
}
// "Manufactured by Whirlpool for KitchenAid, Whirlpool, Jenn-Air, Maytag"
function extractBrands(html) {
  const m = html.match(/Manufactured by[\s\S]{0,400}?<span>\s*for\s*([^<]+)<\/span>/i);
  if (!m) return [];
  return [...new Set(m[1].split(",").map((s) => clean(s)).filter(Boolean))];
}
// Model Cross Reference section: "This part works with the following models:" then
// rows of /Models/<MODEL>/ links paired with a brand. Static HTML carries the
// first page of models (the rest lazy-loads on scroll).
function extractModels(html) {
  const start = html.search(/This part works with the following models:/i);
  if (start < 0) return { models: [], pairs: [] };
  const scope = html.slice(start);
  const pairs = [];
  const seen = new Set();
  for (const m of scope.matchAll(
    /<div class="col-6 col-md-3">\s*([^<]+?)\s*<\/div>\s*<a[^>]*href="\/Models\/([^/"?]+)\//gi
  )) {
    const model = decodeURIComponent(m[2]).toUpperCase();
    if (seen.has(model)) continue;
    seen.add(model);
    pairs.push({ brand: clean(m[1]), model });
    if (pairs.length >= 200) break;
  }
  return { models: pairs.map((p) => p.model), pairs };
}
function dedupeBy(arr, keyFn) {
  const seen = new Set();
  return arr.filter((x) => { const k = keyFn(x); return seen.has(k) ? false : seen.add(k); });
}

module.exports = {
  getPart,
  getModel,
  checkCompatibility,
  searchParts,
  closeBrowser,
  // exposed for testing/inspection
  parsePart,
  parseModel,
};

// --------------------------------------------------------------------- CLI
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    try {
      let out;
      if (argv[0] === "--model") out = await getModel(argv[1]);
      else if (argv[0] === "--compat") out = await checkCompatibility(argv[1], argv[2]);
      else if (argv[0] === "--search") out = await searchParts(argv.slice(1).join(" "));
      else if (argv[0]) out = await getPart(argv[0]);
      else {
        console.log(
          "Usage:\n" +
            "  node server/scraper.js <PART_NUMBER>\n" +
            "  node server/scraper.js --model <MODEL_NUMBER>\n" +
            "  node server/scraper.js --compat <PART_NUMBER> <MODEL_NUMBER>\n" +
            '  node server/scraper.js --search "<query>"'
        );
        process.exit(0);
      }
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      console.error("Error:", e.message);
      process.exitCode = 1;
    } finally {
      await closeBrowser();
    }
  })();
}
