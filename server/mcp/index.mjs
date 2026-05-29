#!/usr/bin/env node
// PartSelect MCP server (stdio).
//
// Exposes the doc-11 tool set over the Model Context Protocol so any MCP client
// (Claude Desktop, the Agent SDK, Cursor, etc.) can drive PartSelect lookups.
// Tools are thin wrappers over server/mcp/dataSource.mjs, which serves either
// the mock catalog or the live scraper (PARTSELECT_DATA=offline|live|auto).
//
// Scope guardrail: this server only covers Refrigerator + Dishwasher parts. The
// guardrail is also enforced in the agent's system prompt; here we tag the
// server + tool descriptions so the model stays in-domain.
//
// Run:
//   node server/mcp/index.mjs                 # offline (default)
//   PARTSELECT_DATA=auto node server/mcp/index.mjs
//   npm run mcp
//
// Register in Claude Desktop (claude_desktop_config.json):
//   {
//     "mcpServers": {
//       "partselect": {
//         "command": "node",
//         "args": ["<abs-path>/server/mcp/index.mjs"],
//         "env": { "PARTSELECT_DATA": "offline" }
//       }
//     }
//   }

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as data from "./dataSource.mjs";

const APPLIANCE = z.enum(["Refrigerator", "Dishwasher"]);

const server = new McpServer({
  name: "partselect",
  version: "0.1.0",
});

// Wrap a handler so every tool returns MCP content (JSON text) and never throws
// across the protocol boundary.
const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }], isError: true });
const handler = (fn) => async (args) => {
  try {
    return ok(await fn(args));
  } catch (e) {
    return fail(e?.message || String(e));
  }
};

// ------------------------------------------------------------------ tools
server.registerTool(
  "search_parts",
  {
    title: "Search parts",
    description:
      "Search the PartSelect catalog for refrigerator or dishwasher parts by free-text " +
      "query, symptom, brand, or category. Use when the user describes a problem or asks " +
      "what part they need rather than giving an exact part number.",
    inputSchema: {
      query: z.string().describe("Free-text terms or symptom, e.g. 'ice maker not working'."),
      appliance: APPLIANCE.optional().describe("Optional appliance filter."),
      brand: z.string().optional().describe("Optional brand filter, e.g. 'Whirlpool'."),
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)."),
    },
  },
  handler((a) => data.searchParts(a))
);

server.registerTool(
  "get_part",
  {
    title: "Get part details",
    description:
      "Get full details for one part by its PartSelect number (PS…) or manufacturer part " +
      "number. Use when the user references a specific part number.",
    inputSchema: {
      part_number: z.string().describe("PartSelect number (e.g. PS11752778) or manufacturer number."),
    },
  },
  handler((a) => data.getPart(a))
);

server.registerTool(
  "check_compatibility",
  {
    title: "Check compatibility",
    description:
      "Check whether a specific part fits a specific appliance model number. Use for " +
      "questions like 'Is this part compatible with my WDT780SAEM1 model?'. Never guess " +
      "fit from brand alone.",
    inputSchema: {
      part_number: z.string().describe("Part number to check."),
      model_number: z.string().describe("Appliance model number, e.g. WDT780SAEM1."),
    },
  },
  handler((a) => data.checkCompatibility(a))
);

server.registerTool(
  "get_model",
  {
    title: "Get model",
    description:
      "Get a model record: brand, appliance type, and the parts that fit it. Use to list " +
      "parts for a customer's appliance model. When the customer asks for a specific KIND of " +
      "part (e.g. a 'door' part, 'drain pump', 'rack'), pass part_type so the result is filtered " +
      "to matching parts only — if it comes back empty, no such part is listed for that model.",
    inputSchema: {
      model_number: z.string().describe("Appliance model number, e.g. WDT780SAEM1."),
      part_type: z
        .string()
        .optional()
        .describe("Optional part-kind filter matched against part names, e.g. 'door', 'drain pump', 'rack'."),
    },
  },
  handler((a) => data.getModel(a))
);

server.registerTool(
  "diagnose",
  {
    title: "Diagnose symptom",
    description:
      "Given a described symptom (and optional appliance type / model), return likely-cause " +
      "parts and repair guidance. Use for troubleshooting like 'the ice maker on my fridge " +
      "is not working'.",
    inputSchema: {
      symptom: z.string().describe("The problem the user described."),
      appliance_type: APPLIANCE.optional(),
      model_number: z.string().optional().describe("Optional model to filter compatible fixes."),
    },
  },
  handler((a) => data.diagnose(a))
);

server.registerTool(
  "get_installation",
  {
    title: "Get installation guide",
    description:
      "Get installation difficulty, estimated time, step-by-step instructions, and an " +
      "install video for a part. Use for 'how do I install part X'.",
    inputSchema: {
      part_number: z.string().describe("Part number to install."),
    },
  },
  handler((a) => data.getInstallation(a))
);

server.registerTool(
  "get_policy",
  {
    title: "Get policy",
    description:
      "Return PartSelect policy facts: returns, warranty, shipping, contact, or order_status. " +
      "Use for customer-service questions. Do not invent policy details.",
    inputSchema: {
      topic: z.enum(["returns", "warranty", "shipping", "contact", "order_status"]),
    },
  },
  handler((a) => data.getPolicy(a))
);

server.registerTool(
  "lookup_order",
  {
    title: "Look up order (stub)",
    description:
      "Look up order status by order number + email. NOTE: requires an authenticated " +
      "PartSelect order integration not connected in this demo — returns guidance, never " +
      "fabricated order data.",
    inputSchema: {
      order_number: z.string().describe("Customer order number."),
      email: z.string().describe("Email on the order."),
    },
  },
  handler((a) => data.lookupOrder(a))
);

// ------------------------------------------------------------------ boot
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is the protocol channel and must stay clean.
  console.error(`[partselect-mcp] ready · data mode: ${data.dataMode()}`);
}

main().catch((e) => {
  console.error("[partselect-mcp] fatal:", e);
  process.exit(1);
});
