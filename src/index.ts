// Remote MCP server on Cloudflare Workers exposing AWS API tools.
//
// Transport: MCP Streamable HTTP (JSON-RPC 2.0 over a single HTTP endpoint).
// POST the JSON-RPC message; the server replies with application/json.
import { TOOLS, TOOL_MAP, type Env } from "./aws";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "aws-mcp", version: "1.0.0" };

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function rpcResult(id: any, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function authorized(request: Request, env: Env): boolean {
  if (!env.MCP_AUTH_TOKEN) return true; // no token configured -> open (not recommended)
  const header = request.headers.get("Authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer === env.MCP_AUTH_TOKEN) return true;
  // also allow ?token= for clients that can't set headers
  const url = new URL(request.url);
  return url.searchParams.get("token") === env.MCP_AUTH_TOKEN;
}

async function handleRpc(req: JsonRpcRequest, env: Env, authed: boolean): Promise<object | null> {
  const { id, method, params } = req;

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null; // notification, no response

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      if (!authed) {
        return rpcResult(id, {
          content: [{
            type: "text",
            text: "Unauthorized: this server requires a token. Add ?token=<MCP_AUTH_TOKEN> to the connector URL (or send an Authorization: Bearer <MCP_AUTH_TOKEN> header).",
          }],
          isError: true,
        });
      }
      const name = params?.name;
      const args = params?.arguments ?? {};
      const tool = TOOL_MAP.get(name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const res = await tool.handler(env, args);
        const ok = res.status >= 200 && res.status < 300;
        const text =
          `HTTP ${res.status} ${res.statusText}\n\n${res.body}`.trim();
        return rpcResult(id, {
          content: [{ type: "text", text }],
          isError: !ok,
        });
      } catch (err: any) {
        return rpcResult(id, {
          content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

const LANDING_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>aws-mcp</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#111}code{background:#f2f2f2;padding:2px 5px;border-radius:4px}h1{margin-bottom:0}</style>
</head><body>
<h1>aws-mcp</h1>
<p>Remote <strong>Model Context Protocol</strong> server that runs AWS API commands with your credentials.</p>
<p>This URL is the MCP endpoint. Add it to an MCP client (e.g. Claude) as a
<em>Streamable HTTP</em> server and send your bearer token in the
<code>Authorization: Bearer &lt;MCP_AUTH_TOKEN&gt;</code> header.</p>
<p>Health: <code>GET /health</code>. Everything else is JSON-RPC over <code>POST</code>.</p>
</body></html>`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === "GET") {
      if (url.pathname === "/health") {
        return jsonResponse({
          ok: true,
          server: SERVER_INFO,
          tools: TOOLS.length,
          hasCredentials: Boolean(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY),
          authRequired: Boolean(env.MCP_AUTH_TOKEN),
        });
      }
      if (url.pathname === "/") {
        // Some MCP clients open a GET for a server->client stream; we don't push.
        if (request.headers.get("Accept")?.includes("text/event-stream")) {
          return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
        }
        return new Response(LANDING_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
        });
      }
      // Anything else (including /.well-known/oauth-* discovery probes) must be a
      // hard 404 so MCP clients don't mistake this for an OAuth-protected server
      // and try to run a sign-in / dynamic-client-registration flow we don't have.
      return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
    }

    // We deliberately do NOT 401 the whole request: MCP clients treat a 401 on
    // the endpoint as "start an OAuth sign-in flow", which this server doesn't
    // implement. Instead we let the handshake (initialize/tools/list) succeed
    // anonymously and enforce the token only when a tool is actually invoked.
    const authed = authorized(request, env);

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(rpcError(null, -32700, "Parse error"), 400);
    }

    // Support single message or a batch array.
    if (Array.isArray(payload)) {
      const responses = [];
      for (const item of payload) {
        const r = await handleRpc(item as JsonRpcRequest, env, authed);
        if (r) responses.push(r);
      }
      return responses.length ? jsonResponse(responses) : new Response(null, { status: 202, headers: CORS_HEADERS });
    }

    const result = await handleRpc(payload as JsonRpcRequest, env, authed);
    if (!result) return new Response(null, { status: 202, headers: CORS_HEADERS });
    return jsonResponse(result);
  },
};
