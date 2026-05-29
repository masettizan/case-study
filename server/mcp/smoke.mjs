// Smoke test: spin the MCP server over stdio with the official client and
// exercise the doc-11 tools end-to-end (offline data). Run: node server/mcp/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "index.mjs");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env, PARTSELECT_DATA: "offline" },
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text || "";
  console.log(`\n--- ${name}(${JSON.stringify(args)}) ---`);
  console.log(text.length > 700 ? text.slice(0, 700) + "\n…(truncated)" : text);
};

// The three case-study queries + a couple more.
await call("get_part", { part_number: "PS11752778" });            // Q1
await call("check_compatibility", { part_number: "PS11752778", model_number: "WDT780SAEM1" }); // Q2 (should be NOT compatible)
await call("check_compatibility", { part_number: "PS11756150", model_number: "WDT780SAEM1" }); // dishwasher part that DOES fit
await call("diagnose", { symptom: "ice maker on my Whirlpool fridge is not working", appliance_type: "Refrigerator" }); // Q3
await call("get_installation", { part_number: "PS11752778" });
await call("get_policy", { topic: "returns" });
await call("lookup_order", { order_number: "PS-123", email: "x@y.com" });

await client.close();
console.log("\nOK — smoke test passed.");
