import { Hono } from "hono";
import type { Bindings } from "./types";
import { handleCallEnd } from "./handlers/call-end";
import { generateVoiceReply } from "./handlers/voice-reply";
import { handleReplay } from "./handlers/replay";
import { handleDashboard } from "./handlers/dashboard";
import {
  handleSendCustomerSms,
  handleSendSupplierRfq,
  handleAckBriefing,
  handleSetOutcome,
  handleMoveToQuoted,
  handleMoveToNegotiating,
  handleResearchCaller,
  handleRenamePerson,
} from "./handlers/actions";
import { handleReindex } from "./handlers/admin";
import { handlePerson, handlePersonJson } from "./handlers/person";
import apiV1 from "./handlers/api";
import { handleMcp } from "./handlers/mcp";

const app = new Hono<{ Bindings: Bindings }>();

// M4 — sales cockpit dashboard at root.
app.get("/", async (c) => handleDashboard(c.env));

// Health check moved off root so the dashboard owns /.
app.get("/health", (c) =>
  c.json({
    name: "b2b-call-agent",
    status: "ok",
    milestone: "M6",
    routes: [
      "GET /",
      "POST /webhook",
      "GET /call/:id",
      "POST /call/:id/send/customer_sms",
      "POST /call/:id/send/supplier_rfq",
      "POST /call/:id/ack/briefing",
      "POST /call/:id/outcome",
      "POST /call/:id/move-to-quoted",
      "POST /call/:id/move-to-negotiating",
      "POST /call/:id/research-caller",
      "GET /person/:phone",
      "GET /person/:phone/json",
      "POST /person/:phone/rename",
      "GET /admin/reindex",
      "GET|POST /api/v1/* (REST API; see GET /api/v1 for discovery)",
      "GET|POST /mcp (MCP server; JSON-RPC 2.0 over HTTP)",
      "GET /health",
    ],
  })
);

// M6 — person workspace (per-customer URL). One page per lead, aggregates
// every call from that phone with rename + actions + timeline.
app.get("/person/:phone", async (c) => {
  const phone = c.req.param("phone");
  const query = new URL(c.req.url).searchParams;
  return handlePerson(phone, c.env, query);
});
app.get("/person/:phone/json", async (c) =>
  handlePersonJson(c.req.param("phone"), c.env)
);
app.post("/person/:phone/rename", async (c) => {
  const formData = await c.req.formData();
  return handleRenamePerson(c.req.param("phone"), formData, c.env);
});

// M2 — single-call replay page. Kept as a legacy alias; redirects to the
// person workspace when the caller's phone is resolvable. Direct callers
// (synthetic test IDs without a phone) still get the single-call view.
app.get("/call/:id", async (c) => {
  const id = c.req.param("id");
  const query = new URL(c.req.url).searchParams;
  return handleReplay(id, c.env, query);
});

// M4 — action endpoints. Each is a form POST that triggers a real outbound
// side effect (SMS via Agent Phone, Slack RFQ post) then redirects back to
// the replay page. Sales rep is the principal — every send is reviewable.
app.post("/call/:id/send/customer_sms", async (c) => {
  const formData = await c.req.formData();
  return handleSendCustomerSms(c.req.param("id"), formData, c.env);
});
app.post("/call/:id/send/supplier_rfq", async (c) => {
  const formData = await c.req.formData();
  return handleSendSupplierRfq(c.req.param("id"), formData, c.env);
});
app.post("/call/:id/ack/briefing", async (c) => handleAckBriefing(c.req.param("id"), c.env));
app.post("/call/:id/outcome", async (c) => {
  const formData = await c.req.formData();
  return handleSetOutcome(c.req.param("id"), formData, c.env);
});
// M5: CRM-stage transitions (manual advance through the sales pipeline).
app.post("/call/:id/move-to-quoted", async (c) => {
  const formData = await c.req.formData();
  return handleMoveToQuoted(c.req.param("id"), formData, c.env);
});
app.post("/call/:id/move-to-negotiating", async (c) => {
  const formData = await c.req.formData();
  return handleMoveToNegotiating(c.req.param("id"), formData, c.env);
});

// M6: Caller research via Browser Use cloud — kicks off an async session;
// result lazy-polls on /call/:id page loads. No form body needed.
app.post("/call/:id/research-caller", async (c) =>
  handleResearchCaller(c.req.param("id"), c.env)
);

// M6 admin: one-shot lead-index backfill from existing call records. Idempotent.
app.get("/admin/reindex", async (c) => handleReindex(c.env));

// M7: REST API for external systems (OA / KOL / marketing / social). Mounted
// under /api/v1/*. Auth via X-API-Key header.
app.route("/api/v1", apiV1);

// M7: MCP server (Streamable HTTP transport) for AI agents (Claude Desktop,
// Cursor, in-house agents). Same X-API-Key auth.
app.get("/mcp", async (c) => handleMcp(c.req.raw, c.env));
app.post("/mcp", async (c) => handleMcp(c.req.raw, c.env));

// Single Agent Phone webhook endpoint.
//
// Per https://docs.agentphone.ai/documentation/guides/webhooks the events are:
//   - agent.message     (channel: sms/mms/imessage/voice)
//                       Voice in-progress REQUIRES sync response with {text}
//                       — that's what the agent SAYS. Empty/invalid → silence.
//   - agent.reaction    (channel: imessage) — fire-and-forget
//   - agent.call_ended  (channel: voice)    — fire-and-forget
//
// M1 contract (per design doc Operating Decisions):
//   §3 Slack stub-format summary on call-end
//   §4 Always 200 OK so Agent Phone doesn't retry (we accept data loss)
//   §5 No idempotency
//   §6 Voice reply responses synchronous, well under 5s (FSM, no I/O)
//   No signature verification in M1 — M2 will verify X-Webhook-Signature
//   (HMAC-SHA256 of "{X-Webhook-Timestamp}.{raw_body}" with the whsec_ secret).
app.post("/webhook", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const event = String(body.event ?? body.type ?? "unknown");
  const channel = String((body as Record<string, unknown>).channel ?? "unknown");
  const data =
    body.data && typeof body.data === "object"
      ? (body.data as Record<string, unknown>)
      : {};
  const status = String((data as Record<string, unknown>).status ?? "");

  console.log(`[webhook] event=${event} channel=${channel} status=${status}`);
  // NOTE: full body JSON dump removed from hot path — saves ~10-30ms of
  // serialization per voice in-progress event. Use ngrok inspector (port 4040)
  // when debugging payloads.

  // ── 1. Voice in-progress — MUST return {text} or caller hears silence ──
  // JSON mode (not streaming). We tried NDJSON streaming and it only saved
  // ~100-200ms on short voice replies (Gemini pre-fill dominates), plus TTS
  // split numbers awkwardly mid-stream. Total path: ~1.4-1.7s typical.
  if (event === "agent.message" && channel === "voice") {
    const reply = await generateVoiceReply(body, c.env);
    return c.json(reply);
  }

  // ── 2. Call ended — Airtable + Slack, no agent reply needed ──
  if (event === "agent.call_ended") {
    // Merge wrapper-level (event, channel, timestamp, agentId) with inner data
    // for full traceability in raw_payload + structured-field extraction.
    // Pass request origin so call-end handler can build the public replay URL.
    let origin: string | null = null;
    try {
      origin = new URL(c.req.url).origin;
    } catch {
      /* ignore — fallback to null, Slack won't get a replay link */
    }
    await handleCallEnd({ ...body, ...data } as never, c.env, origin);
    return c.json({ ok: true });
  }

  // ── 3. SMS/iMessage/MMS message — for M1 we just ack ──
  //
  // Returning `{text}` here would have the AGENT REPLY with an SMS — kept off
  // for M1 to focus on the voice happy path. Flip on by uncommenting:
  //   if (event === "agent.message") return c.json({ text: "Thanks, a human will follow up." });
  if (event === "agent.message") {
    return c.json({ ok: true });
  }

  // ── 4. iMessage reaction — no-op ──
  if (event === "agent.reaction") {
    return c.json({ ok: true });
  }

  // ── 5. Unknown event — log + 200 (don't trigger Agent Phone retries) ──
  console.warn(`[webhook] unhandled event=${event} channel=${channel}`);
  return c.json({ ok: true, handled: false, event });
});

// 404 fallback that prints the path — helps spot Agent Phone misconfig fast.
app.notFound((c) => {
  console.warn("[404]", c.req.method, c.req.path);
  return c.json({ error: "not_found", path: c.req.path }, 404);
});

export default app;
