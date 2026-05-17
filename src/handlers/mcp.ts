import type { Bindings } from "../types";
import {
  listPersons,
  getPerson,
  renamePerson,
  startResearch,
  listCalls,
  getCall,
  sendCustomerSmsAction,
  sendSupplierRfqAction,
  ackBriefingAction,
  moveToQuotedAction,
  moveToNegotiatingAction,
  setOutcomeAction,
  listProducts,
  searchProductsAction,
  reindexLeadsAction,
  type ServiceResult,
} from "../lib/services";

// ─── MCP server (Streamable HTTP transport) ──────────────────────────
//
// Single POST endpoint at /mcp. Accepts JSON-RPC 2.0 requests; returns
// JSON-RPC 2.0 responses synchronously (no SSE — we don't push server-
// initiated events). All requests must carry the `X-API-Key` header.
//
// Implements the MCP methods our use case needs:
//   - initialize / notifications/initialized
//   - tools/list, tools/call
//   - resources/list, resources/read
//
// Each tool is a thin wrapper around the same service functions the REST
// API uses, so behavior stays in sync.

const PROTOCOL_VERSION = "2025-06-18"; // MCP spec date our server speaks
const SERVER_NAME = "b2b-call-agent";
const SERVER_VERSION = "0.1.0";

// JSON-RPC 2.0 error codes
const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Server-defined application errors live in [-32000, -32099]
  UNAUTHORIZED: -32001,
};

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: number | string | null | undefined, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(
  id: number | string | null | undefined,
  code: number,
  message: string,
  data?: unknown
): Response {
  const errorObj: Record<string, unknown> = { code, message };
  if (data !== undefined) errorObj.data = data;
  return jsonResponse({ jsonrpc: "2.0", id: id ?? null, error: errorObj });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Convert a service result to a tool/call response. Successful results are
// rendered as a JSON text content block. Failures become isError=true with
// the message in the content (MCP spec convention).
function toolResultFrom<T>(r: ServiceResult<T>): unknown {
  if (r.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(r.data, null, 2),
        },
      ],
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `${r.code}: ${r.message}`,
      },
    ],
    isError: true,
  };
}

// ─── Tool definitions (JSON Schema) ──────────────────────────────────

const TOOLS = [
  {
    name: "list_persons",
    description:
      "List all leads (customers), deduped by phone. Each entry is a summary with latest pipeline state, qualification score, and research enrichment status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_person",
    description:
      "Get full detail for one lead: display name, all calls (call_id + received_at), and the Browser Use research output if any.",
    inputSchema: {
      type: "object",
      properties: { phone: { type: "string", description: "E.164 phone, e.g. +16692120332" } },
      required: ["phone"],
      additionalProperties: false,
    },
  },
  {
    name: "rename_person",
    description:
      "Set or clear the customer-facing display name for a lead. Pass empty string or null to clear.",
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string" },
        display_name: { type: ["string", "null"], description: "Empty/null clears the name." },
      },
      required: ["phone"],
      additionalProperties: false,
    },
  },
  {
    name: "start_research",
    description:
      "Kick off a Browser Use background check on the caller's company. Async — returns the task_id; poll get_person for the result. ~$0.10/run; ~30-90s typical.",
    inputSchema: {
      type: "object",
      properties: { phone: { type: "string" } },
      required: ["phone"],
      additionalProperties: false,
    },
  },
  {
    name: "list_calls",
    description: "List all call records (each is one inbound conversation) with qualification and action status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_call",
    description:
      "Get full detail for one call: transcript, Gemini-extracted entities, AI-generated drafts (SMS/RFQ/briefing), action history, recording URL.",
    inputSchema: {
      type: "object",
      properties: { call_id: { type: "string" } },
      required: ["call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "send_sms",
    description:
      "Send an SMS to the caller via Agent Phone outbound. WARNING: triggers a real text message. ASCII only (non-ASCII chars are stripped).",
    inputSchema: {
      type: "object",
      properties: {
        call_id: { type: "string" },
        text: { type: "string", description: "Plain-text SMS body. Non-ASCII chars will be stripped." },
      },
      required: ["call_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "send_rfq",
    description:
      "Post a Chinese-language RFQ to the #sourcing-china Slack channel. Used by sales to engage the factory team.",
    inputSchema: {
      type: "object",
      properties: {
        call_id: { type: "string" },
        text: { type: "string", description: "RFQ text (Chinese supported)." },
      },
      required: ["call_id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "ack_briefing",
    description: "Mark the internal sales briefing as read for one call.",
    inputSchema: {
      type: "object",
      properties: { call_id: { type: "string" } },
      required: ["call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "move_to_quoted",
    description:
      "Advance the deal to Quoted: factory has confirmed pricing and lead time. Use after the supplier RFQ is filled.",
    inputSchema: {
      type: "object",
      properties: {
        call_id: { type: "string" },
        factory_price_usd: { type: ["number", "null"] },
        factory_lead_time_weeks: { type: ["number", "null"] },
        notes: { type: ["string", "null"] },
      },
      required: ["call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "move_to_negotiating",
    description: "Advance the deal to Negotiating: customer has engaged with the quote.",
    inputSchema: {
      type: "object",
      properties: {
        call_id: { type: "string" },
        sentiment: {
          type: ["string", "null"],
          enum: ["positive", "negotiating", "objecting", null],
        },
        notes: { type: ["string", "null"] },
      },
      required: ["call_id"],
      additionalProperties: false,
    },
  },
  {
    name: "close_deal",
    description: "Close out the deal: won, lost, or nurture (re-engage later).",
    inputSchema: {
      type: "object",
      properties: {
        call_id: { type: "string" },
        outcome: { type: "string", enum: ["won", "lost", "nurture"] },
        note: { type: ["string", "null"] },
      },
      required: ["call_id", "outcome"],
      additionalProperties: false,
    },
  },
  {
    name: "list_products",
    description: "List the full FerroLaser product catalog (15 SKUs, scraped from ferrolaser.com via Browser Use).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_products",
    description:
      "Semantic-search the FerroLaser catalog via Supermemory. Use natural language: 'fiber laser for 6mm aluminum signs under $25k'.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "reindex_leads",
    description:
      "Rebuild the phone→calls lead index by scanning all existing call records. Idempotent. Run after bulk-imports.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// ─── Resource definitions ────────────────────────────────────────────

const RESOURCES = [
  {
    uri: "catalog://products",
    name: "FerroLaser product catalog",
    description: "Full product catalog as JSON.",
    mimeType: "application/json",
  },
  {
    uri: "persons://all",
    name: "All leads (summary)",
    description: "Summary list of every lead. Same shape as `list_persons` tool output.",
    mimeType: "application/json",
  },
  {
    uri: "calls://all",
    name: "All calls (summary)",
    description: "Summary list of every call. Same shape as `list_calls` tool output.",
    mimeType: "application/json",
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: "person://{phone}",
    name: "Lead detail by phone",
    description: "Full lead detail for one phone (E.164, URL-encoded). Same shape as `get_person`.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "call://{call_id}",
    name: "Call detail by id",
    description: "Full call detail including transcript + drafts + entities. Same shape as `get_call`.",
    mimeType: "application/json",
  },
];

// ─── Method handlers ─────────────────────────────────────────────────

async function handleToolsCall(
  env: Bindings,
  params: Record<string, unknown>
): Promise<unknown> {
  const name = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const phoneArg = typeof args.phone === "string" ? args.phone : "";
  const callIdArg = typeof args.call_id === "string" ? args.call_id : "";
  const textArg = typeof args.text === "string" ? args.text : "";

  switch (name) {
    case "list_persons":
      return toolResultFrom(await listPersons(env));
    case "get_person":
      return toolResultFrom(await getPerson(env, phoneArg));
    case "rename_person": {
      const dn = args.display_name;
      const display_name =
        dn === null || dn === undefined ? null : typeof dn === "string" ? dn : null;
      return toolResultFrom(await renamePerson(env, phoneArg, display_name));
    }
    case "start_research":
      return toolResultFrom(await startResearch(env, phoneArg));
    case "list_calls":
      return toolResultFrom(await listCalls(env));
    case "get_call":
      return toolResultFrom(await getCall(env, callIdArg));
    case "send_sms":
      return toolResultFrom(await sendCustomerSmsAction(env, callIdArg, textArg));
    case "send_rfq":
      return toolResultFrom(await sendSupplierRfqAction(env, callIdArg, textArg));
    case "ack_briefing":
      return toolResultFrom(await ackBriefingAction(env, callIdArg));
    case "move_to_quoted":
      return toolResultFrom(
        await moveToQuotedAction(env, callIdArg, {
          factory_price_usd:
            typeof args.factory_price_usd === "number" ? args.factory_price_usd : null,
          factory_lead_time_weeks:
            typeof args.factory_lead_time_weeks === "number" ? args.factory_lead_time_weeks : null,
          notes: typeof args.notes === "string" ? args.notes : null,
        })
      );
    case "move_to_negotiating": {
      const s = args.sentiment;
      const sentiment =
        s === "positive" || s === "negotiating" || s === "objecting" ? s : null;
      return toolResultFrom(
        await moveToNegotiatingAction(env, callIdArg, {
          sentiment,
          notes: typeof args.notes === "string" ? args.notes : null,
        })
      );
    }
    case "close_deal": {
      const outcome = args.outcome;
      if (outcome !== "won" && outcome !== "lost" && outcome !== "nurture") {
        return toolResultFrom({
          ok: false as const,
          code: "invalid_input",
          message: "outcome must be won|lost|nurture",
          status: 400,
        });
      }
      const note = typeof args.note === "string" ? args.note : null;
      return toolResultFrom(await setOutcomeAction(env, callIdArg, outcome, note));
    }
    case "list_products":
      return toolResultFrom(listProducts());
    case "search_products": {
      const query = typeof args.query === "string" ? args.query : "";
      return toolResultFrom(await searchProductsAction(env, query));
    }
    case "reindex_leads":
      return toolResultFrom(await reindexLeadsAction(env));
    default:
      return toolResultFrom({
        ok: false as const,
        code: "unknown_tool",
        message: `unknown tool: ${name}`,
        status: 400,
      });
  }
}

async function handleResourcesRead(
  env: Bindings,
  params: Record<string, unknown>
): Promise<unknown> {
  const uri = typeof params.uri === "string" ? params.uri : "";
  const contentText = await resolveResource(env, uri);
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: contentText,
      },
    ],
  };
}

async function resolveResource(env: Bindings, uri: string): Promise<string> {
  if (uri === "catalog://products") {
    const r = listProducts();
    return JSON.stringify(r.ok ? r.data : { error: r }, null, 2);
  }
  if (uri === "persons://all") {
    const r = await listPersons(env);
    return JSON.stringify(r.ok ? r.data : { error: r }, null, 2);
  }
  if (uri === "calls://all") {
    const r = await listCalls(env);
    return JSON.stringify(r.ok ? r.data : { error: r }, null, 2);
  }
  if (uri.startsWith("person://")) {
    const phone = decodeURIComponent(uri.slice("person://".length));
    const r = await getPerson(env, phone);
    return JSON.stringify(r.ok ? r.data : { error: r }, null, 2);
  }
  if (uri.startsWith("call://")) {
    const callId = decodeURIComponent(uri.slice("call://".length));
    const r = await getCall(env, callId);
    return JSON.stringify(r.ok ? r.data : { error: r }, null, 2);
  }
  return JSON.stringify({ error: { code: "unknown_uri", message: `unrecognized URI: ${uri}` } });
}

// ─── Top-level HTTP handler ──────────────────────────────────────────

export async function handleMcp(req: Request, env: Bindings): Promise<Response> {
  // Auth.
  const provided = req.headers.get("x-api-key");
  const expected = env.API_KEY;
  if (!expected) {
    return jsonResponse(
      { error: { code: "server_misconfigured", message: "API_KEY is not configured on the server" } },
      503
    );
  }
  if (!provided || provided !== expected) {
    return rpcError(null, RPC.UNAUTHORIZED, "missing or invalid X-API-Key");
  }

  // Only POST is supported. GET on /mcp returns a discovery doc.
  if (req.method === "GET") {
    return jsonResponse({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocol: PROTOCOL_VERSION,
      transport: "Streamable HTTP (single POST per request)",
      note: "POST JSON-RPC 2.0 messages to this endpoint. See method 'initialize' first.",
    });
  }
  if (req.method !== "POST") {
    return rpcError(null, RPC.INVALID_REQUEST, "method not allowed; use POST");
  }

  // Parse body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, RPC.PARSE_ERROR, "request body is not valid JSON");
  }

  // Batch is allowed by JSON-RPC. For simplicity we handle single only;
  // batch requests fall back to the first element.
  const msg = Array.isArray(body) ? body[0] : body;
  if (!msg || typeof msg !== "object") {
    return rpcError(null, RPC.INVALID_REQUEST, "request is not a JSON-RPC object");
  }
  const rpc = msg as JsonRpcRequest;
  if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    return rpcError(rpc.id ?? null, RPC.INVALID_REQUEST, "missing jsonrpc or method");
  }

  const id = rpc.id ?? null;
  const params = (rpc.params ?? {}) as Record<string, unknown>;
  try {
    switch (rpc.method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
          },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });

      case "notifications/initialized":
        // Notifications have no response body — return 204 to be polite.
        return new Response(null, { status: 204 });

      case "ping":
        return rpcResult(id, {});

      case "tools/list":
        return rpcResult(id, { tools: TOOLS });

      case "tools/call":
        return rpcResult(id, await handleToolsCall(env, params));

      case "resources/list":
        return rpcResult(id, { resources: RESOURCES });

      case "resources/templates/list":
        return rpcResult(id, { resourceTemplates: RESOURCE_TEMPLATES });

      case "resources/read":
        return rpcResult(id, await handleResourcesRead(env, params));

      default:
        return rpcError(id, RPC.METHOD_NOT_FOUND, `unknown method: ${rpc.method}`);
    }
  } catch (e) {
    console.error("[mcp] internal error:", e);
    return rpcError(id, RPC.INTERNAL_ERROR, (e as Error).message);
  }
}
