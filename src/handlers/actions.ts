import type { Bindings } from "../types";
import type { CallRecord } from "../lib/render";
import { createResearchTask } from "../lib/browser-use";
import { getLead, saveLead, normalizePhone, type LeadIndex } from "../lib/leads";
import {
  loadRecord,
  saveRecord,
  withStateChange,
  getCallerPhone,
  getAgentId,
  sendAgentPhoneSms,
} from "../lib/call-io";

// Build the URL to redirect to after a per-call action. Prefers the person
// view (/person/<normalizedPhone>) so the sales rep stays in the right
// context; falls back to /call/<call_id> when the call has no resolvable
// phone (synthetic test records).
function leadOrCallUrl(rec: CallRecord, suffix: string): string {
  const phone = normalizePhone(getCallerPhone(rec));
  if (phone) return `/person/${encodeURIComponent(phone)}${suffix}`;
  return `/call/${encodeURIComponent(rec.call_id)}${suffix}`;
}

// M4 action endpoints. Form POSTs from the /person view; we apply the side
// effect, persist state, then 303 redirect back. Business logic + IO
// helpers live in src/lib/call-io.ts and are shared with the REST/MCP
// pathways.

function redirectTo(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: { Location: path, "cache-control": "no-store" },
  });
}

// ── Action handlers ─────────────────────────────────────────────────

export async function handleSendCustomerSms(
  callId: string,
  formData: FormData,
  env: Bindings
): Promise<Response> {
  const rec = await loadRecord(env, callId);
  if (!rec) return new Response("Call not found", { status: 404 });

  const sentText = String(formData.get("text") ?? "").trim();
  if (!sentText) return redirectTo(leadOrCallUrl(rec, "?err=empty_sms"));

  const callerPhone = getCallerPhone(rec);
  if (!callerPhone) {
    return redirectTo(leadOrCallUrl(rec, "?err=no_caller_phone"));
  }
  const agentId = getAgentId(rec);
  if (!agentId) {
    return redirectTo(leadOrCallUrl(rec, "?err=no_agent_id"));
  }

  const result = await sendAgentPhoneSms(env, agentId, callerPhone, sentText);
  if (!result.ok) {
    console.error("[actions] sms send failed:", result.error);
    return redirectTo(
      leadOrCallUrl(rec, `?err=sms_failed&detail=${encodeURIComponent(result.error || "unknown")}`)
    );
  }

  rec.actions = {
    ...(rec.actions ?? {}),
    customer_sms: {
      sent_at: new Date().toISOString(),
      sent_text: sentText,
      message_id: result.id,
    },
  };
  withStateChange(rec);
  await saveRecord(env, rec);
  console.log("[actions] customer_sms sent for", callId, "msg_id=", result.id);
  return redirectTo(leadOrCallUrl(rec, "?ok=customer_sms"));
}

export async function handleSendSupplierRfq(
  callId: string,
  formData: FormData,
  env: Bindings
): Promise<Response> {
  const rec = await loadRecord(env, callId);
  if (!rec) return new Response("Call not found", { status: 404 });

  const sentText = String(formData.get("text") ?? "").trim();
  if (!sentText) return redirectTo(leadOrCallUrl(rec, "?err=empty_rfq"));

  // Post to Slack — prefer the dedicated sourcing-china webhook if configured,
  // otherwise fall back to the main webhook with a clear prefix.
  const hasSourcing = typeof env.SOURCING_WEBHOOK_URL === "string" && env.SOURCING_WEBHOOK_URL.length > 0;
  const sourcingUrl = hasSourcing ? env.SOURCING_WEBHOOK_URL! : env.SLACK_WEBHOOK_URL;
  console.log(`[actions] RFQ routing: hasSourcing=${hasSourcing} target=${hasSourcing ? "#sourcing-china" : "#fallback main"}`);
  if (!sourcingUrl) {
    return redirectTo(leadOrCallUrl(rec, "?err=no_sourcing_webhook"));
  }

  const message = hasSourcing
    ? sentText
    : `🇨🇳 *[SOURCING CHINA — RFQ for call ${callId}]*\n\n${sentText}`;

  // Custom shim: post directly to the sourcing webhook with the chosen text
  try {
    const resp = await fetch(sourcingUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.error("[actions] sourcing slack failed:", resp.status, t.slice(0, 200));
      return redirectTo(leadOrCallUrl(rec, "?err=rfq_slack_failed"));
    }
  } catch (err) {
    console.error("[actions] sourcing slack threw:", err);
    return redirectTo(leadOrCallUrl(rec, "?err=rfq_slack_failed"));
  }

  rec.actions = {
    ...(rec.actions ?? {}),
    supplier_rfq: {
      sent_at: new Date().toISOString(),
      sent_text: sentText,
    },
  };
  withStateChange(rec);
  await saveRecord(env, rec);
  console.log("[actions] supplier_rfq sent for", callId);
  return redirectTo(leadOrCallUrl(rec, "?ok=supplier_rfq"));
}

export async function handleAckBriefing(
  callId: string,
  env: Bindings
): Promise<Response> {
  const rec = await loadRecord(env, callId);
  if (!rec) return new Response("Call not found", { status: 404 });

  rec.actions = {
    ...(rec.actions ?? {}),
    briefing: { acked_at: new Date().toISOString() },
  };
  withStateChange(rec);
  await saveRecord(env, rec);
  console.log("[actions] briefing acked for", callId);
  return redirectTo(leadOrCallUrl(rec, "?ok=briefing"));
}

// ── Archive (hand off to the customer's own CRM) ────────────────────
// v0.2: the only post-outreach action. Marks the lead as done from our
// side — downstream stages (quote / negotiation / close) live in the
// customer's HubSpot / Salesforce / Feishu OA, not here.
export async function handleArchive(
  callId: string,
  formData: FormData,
  env: Bindings
): Promise<Response> {
  const rec = await loadRecord(env, callId);
  if (!rec) return new Response("Call not found", { status: 404 });

  rec.actions = {
    ...(rec.actions ?? {}),
    archived_at: new Date().toISOString(),
    archived_note: String(formData.get("note") ?? "").trim() || undefined,
  };
  withStateChange(rec);
  await saveRecord(env, rec);
  console.log("[actions] archived:", callId);
  return redirectTo(leadOrCallUrl(rec, "?ok=archived"));
}

// ── Rename a lead ────────────────────────────────────────────────────
// Sales rep names the customer for easier scanning. Stored at the lead
// level (per phone) so it persists across calls.
export async function handleRenamePerson(
  rawPhone: string,
  formData: FormData,
  env: Bindings
): Promise<Response> {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    return new Response("Invalid phone", { status: 400 });
  }
  const name = String(formData.get("display_name") ?? "").trim();
  const lead = (await getLead(env, phone)) ?? {
    phone,
    calls: [],
    last_seen: new Date().toISOString(),
  };
  lead.display_name = name.length > 0 ? name : null;
  await saveLead(env, lead);
  console.log(`[actions] renamed ${phone} → ${name || "(cleared)"}`);
  return redirectTo(`/person/${encodeURIComponent(phone)}?ok=renamed`);
}

// ── Caller research (Browser Use background check) ──────────────────
//
// Async pipeline: kick off a Browser Use cloud session, stash the task_id +
// "pending" status on the LEAD (not the call — research is per-phone), then
// lazy-poll on subsequent /call/:id page loads.
//
// Research is stored on the lead because a single caller might generate
// multiple calls and we don't want to redo a $0.30 background check each
// time they ring back.
export async function handleResearchCaller(
  callId: string,
  env: Bindings
): Promise<Response> {
  const rec = await loadRecord(env, callId);
  if (!rec) return new Response("Call not found", { status: 404 });

  const callerPhone = getCallerPhone(rec);
  const norm = normalizePhone(callerPhone);
  if (!norm) {
    return redirectTo(leadOrCallUrl(rec, "?err=no_caller_phone"));
  }

  // If the lead already has a pending or done research, don't kick off another.
  const existingLead = await getLead(env, norm);
  if (existingLead?.research && existingLead.research.status === "pending") {
    return redirectTo(leadOrCallUrl(rec, "?ok=research_pending"));
  }

  // Build research input from the call's extracted entities.
  const ent = rec.entities ?? null;
  const result = await createResearchTask(env, {
    phone: norm,
    caller_name: ent?.caller_name ?? null,
    caller_company: ent?.caller_company ?? null,
    application: ent?.application ?? null,
    material: ent?.material ?? null,
    budget_usd: ent?.budget_usd_max ?? ent?.budget_usd_min ?? null,
  });

  if (!result.ok) {
    console.error("[actions] research kickoff failed:", result.error);
    return redirectTo(
      leadOrCallUrl(rec, `?err=research_failed&detail=${encodeURIComponent(result.error)}`)
    );
  }

  const lead: LeadIndex = existingLead ?? {
    phone: norm,
    calls: [{ call_id: rec.call_id, received_at: rec.received_at }],
    last_seen: rec.received_at,
  };
  lead.research = {
    task_id: result.session_id,
    status: "pending",
    started_at: new Date().toISOString(),
    live_url: result.live_url ?? null,
    raw_output: null,
  };
  await saveLead(env, lead);
  console.log(`[actions] research started session=${result.session_id} for ${norm}`);
  return redirectTo(leadOrCallUrl(rec, "?ok=research_started"));
}

// Move quoted → negotiating. Sales captures that the customer responded
// (sentiment + notes optional).
