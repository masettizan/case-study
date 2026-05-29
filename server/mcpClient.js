// MCP client bridge for the web chat backend.
//
// Spawns the PartSelect MCP server (server/mcp/index.mjs) over stdio and exposes
// its tools to the in-process agent loop (server/index.js). One server
// implementation, two consumers: this web chat + any external MCP client
// (Claude Desktop, Cursor, etc.). See server/mcp/README.md.
//
// The MCP SDK ships ESM-only, so we load it via dynamic import() from this
// CommonJS module and cache a single connected client for the process.

const path = require("path");

// Default to live data so the web chat sees real partselect.com parts/models,
// not just the offline mock catalog. Override with PARTSELECT_DATA=offline|auto.
const DATA_MODE = process.env.PARTSELECT_DATA || "live";
const MCP_SERVER = path.join(__dirname, "mcp", "index.mjs");

let _clientPromise = null;

// Connect once; reuse the client for every request. On failure, clear the cache
// so a later request can retry instead of being stuck with a dead promise.
async function getClient() {
  if (_clientPromise) return _clientPromise;
  _clientPromise = (async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_SERVER],
      env: { ...process.env, PARTSELECT_DATA: DATA_MODE },
    });
    const client = new Client({ name: "partselect-web", version: "0.1.0" });
    await client.connect(transport);
    return client;
  })();
  _clientPromise.catch(() => { _clientPromise = null; });
  return _clientPromise;
}

// MCP tool list converted to the OpenAI/Ollama function-calling shape.
async function listOllamaTools() {
  const client = await getClient();
  const { tools } = await client.listTools();
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  }));
}

// Call an MCP tool and parse its JSON text content back into an object. MCP tool
// results are wrapped as { content: [{ type:"text", text }] } (see index.mjs).
async function callTool(name, args) {
  const client = await getClient();
  const res = await client.callTool({ name, arguments: args || {} });
  const text = res?.content?.find((c) => c.type === "text")?.text || "{}";
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

module.exports = { getClient, listOllamaTools, callTool, DATA_MODE };
