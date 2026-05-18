import type { Bindings } from "../types";
import type { CallRecord, CallState } from "./render";

// Shared IO + state helpers for everything that touches a CallRecord:
//   - UI handlers (src/handlers/actions.ts) — form POSTs + 303 redirects
//   - REST API (src/handlers/api.ts) — JSON in/out
//   - MCP server (src/handlers/mcp.ts) — JSON-RPC tool calls
//
// All three pathways converge here so KV layout, state transitions, and
// outbound side effects (Agent Phone SMS) stay consistent.

export async function loadRecord(
  env: Bindings,
  callId: string
): Promise<CallRecord | null> {
  const raw = await env.CALLS.get(callId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CallRecord;
  } catch {
    return null;
  }
}

export async function saveRecord(env: Bindings, rec: CallRecord): Promise<void> {
  await env.CALLS.put(rec.call_id, JSON.stringify(rec), { expirationTtl: 86400 });
}

// v0.2 state: archived > 3-of-3 outreach actions > new_lead.
// Down-stream stages (quoted / negotiating / won / lost / nurture) live in
// the customer's own CRM now — we don't track them here.
export function computeState(rec: CallRecord): CallState {
  const a = rec.actions ?? {};
  if (a.archived_at) return "archived";
  const sent = [a.customer_sms, a.supplier_rfq, a.briefing].filter(Boolean).length;
  if (sent >= 3) return "outreach_sent";
  return "new_lead";
}

// Bumps stage_entered_at when state changes. Mutates the record in place
// and returns the same reference for chaining.
export function withStateChange(rec: CallRecord): CallRecord {
  const newState = computeState(rec);
  if (rec.state !== newState) {
    rec.actions = rec.actions ?? {};
    rec.actions.stage_entered_at = new Date().toISOString();
    rec.state = newState;
  }
  return rec;
}

export function getCallerPhone(rec: CallRecord): string | null {
  const d = (rec.payload?.data ?? rec.payload ?? {}) as Record<string, unknown>;
  if (typeof d.from === "string") return d.from;
  if (typeof d.caller_phone === "string") return d.caller_phone;
  return null;
}

export function getAgentId(rec: CallRecord): string | null {
  const p = rec.payload as Record<string, unknown>;
  if (typeof p.agentId === "string") return p.agentId;
  if (typeof p.agent_id === "string") return p.agent_id;
  return null;
}

// Agent Phone outbound SMS — +19787084114 line (SMS-capable).
const SMS_NUMBER_ID = "cmpa8t6br0ch3jz00rsz7dfeg";

export async function sendAgentPhoneSms(
  env: Bindings,
  agentId: string,
  toNumber: string,
  bodyText: string,
  attempt = 1
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!env.AGENT_PHONE_API_KEY) return { ok: false, error: "no API key" };
  const apiBase = env.AGENT_PHONE_API_BASE || "https://api.agentphone.ai/v1";
  // Strip non-ASCII — Agent Phone body parser rejects emoji etc with HTTP 400.
  const safeBody = bodyText.replace(/[^\x00-\x7F]/g, "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch(`${apiBase}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.AGENT_PHONE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: agentId,
        number_id: SMS_NUMBER_ID,
        to_number: toNumber,
        body: safeBody,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      if ((resp.status === 502 || resp.status === 503 || resp.status === 504) && attempt < 2) {
        console.warn(`[call-io] sms attempt ${attempt} got ${resp.status}, retrying once…`);
        return sendAgentPhoneSms(env, agentId, toNumber, bodyText, attempt + 1);
      }
      return { ok: false, error: `${resp.status}: ${t.slice(0, 200)}` };
    }
    const j = (await resp.json()) as Record<string, unknown>;
    return { ok: true, id: String(j.id ?? "") };
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    if (e.name === "AbortError") {
      if (attempt < 2) {
        console.warn(`[call-io] sms attempt ${attempt} timed out, retrying once…`);
        return sendAgentPhoneSms(env, agentId, toNumber, bodyText, attempt + 1);
      }
      return { ok: false, error: "Agent Phone API timed out (>6s twice)" };
    }
    return { ok: false, error: e.message };
  }
}
