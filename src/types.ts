// Cloudflare Workers env bindings. Populated from .dev.vars locally, from
// `wrangler secret put` in production. Add new secrets here AND in
// .dev.vars.example to keep types and docs in sync.
export interface Bindings {
  AIRTABLE_TOKEN: string;
  AIRTABLE_BASE_ID: string;
  AIRTABLE_TABLE_NAME: string;
  SLACK_WEBHOOK_URL: string;
  // Agent Phone uses HMAC-SHA256 ({timestamp}.{raw_body} with whsec_ secret).
  // M1 stores it; M2 wiring planned. Verification not yet enabled.
  AGENT_PHONE_SIGNING_SECRET?: string;
  // M2.1: REST API access for the recording feature. The replay page calls
  // GET /v1/calls/{call_id} with this key to check `recordingAvailable` +
  // get `recordingUrl`. The recording endpoint itself is public.
  AGENT_PHONE_API_KEY?: string;
  AGENT_PHONE_API_BASE?: string;
  // M2: Workers KV for call records — written on agent.call_ended, read by
  // GET /call/:id replay page handler.
  CALLS: KVNamespace;
  // M3: sponsor integrations
  GEMINI_API_KEY?: string; // Google DeepMind — voice-reply LLM + post-call analysis
  SUPERMEMORY_API_KEY?: string; // Supermemory — product catalog + caller memory
  BROWSER_USE_API_KEY?: string; // Browser Use — scrape ferrolaser.com product pages
  // M4: dedicated Slack webhook for the #sourcing-china channel where the
  // AI-drafted supplier RFQs land. Falls back to SLACK_WEBHOOK_URL (with a
  // prefix so it's distinguishable) when not configured.
  SOURCING_WEBHOOK_URL?: string;
  // M7: shared API key for /api/v1/* REST endpoints and /mcp MCP server.
  // Downstream systems (OA, marketing, KOL, social, AI agents) pass it via
  // the `X-API-Key` header. Hackathon-mode single-key auth; rotate by
  // updating .dev.vars / wrangler secrets and reissuing to consumers.
  API_KEY?: string;
}

// Agent Phone payload shapes are TBD — these types are placeholders that match
// what we *expect*. The M1 verification step is precisely to capture a real
// callback and tighten these. Keep them permissive (optional fields) until we
// have real data.

export interface FunctionCallRequest {
  name?: string;
  arguments?: Record<string, unknown>;
  call_id?: string;
  // ...anything else Agent Phone sends; we accept and log.
  [key: string]: unknown;
}

export interface CallEndPayload {
  call_id?: string;
  caller_phone?: string;
  started_at?: string;
  ended_at?: string;
  duration_seconds?: number;
  transcript?: string;
  // ...anything else; stored verbatim in raw_payload.
  [key: string]: unknown;
}
