import type { Bindings } from "../types";

// Lead index — maps a caller phone number to the calls we've seen from them.
//
// KV layout:
//   lead:{normalizedPhone} -> LeadIndex (JSON)
//
// "Lead" is the right conceptual unit for the cockpit page even though most
// of our records are keyed by call_id. A single phone may produce multiple
// calls; once a sales rep opens a call, the page should show the FULL
// history of touchpoints, not just this one call.
//
// We append on call-end. Concurrent writes to the same lead are theoretically
// possible but the hackathon traffic doesn't warrant transactional KV ops.

export interface LeadCallEntry {
  call_id: string;
  received_at: string; // ISO
}

export interface LeadIndex {
  phone: string;             // normalized E.164-ish (the canonical form)
  calls: LeadCallEntry[];    // newest first
  last_seen: string;         // ISO of the newest call
  // Sales rep can name the customer here (e.g. "Ron @ Hudson Sign Co").
  // Falls back to caller_name + caller_company from the latest call's
  // Gemini extraction when null.
  display_name?: string | null;
  // Research / enrichment fields are populated by the Browser Use background
  // check action. Stored on the lead (not the call) so it's reusable across
  // future calls from the same phone.
  research?: LeadResearch | null;
}

export interface LeadResearch {
  task_id: string;                   // Browser Use session id
  status: "pending" | "done" | "failed";
  started_at: string;
  finished_at?: string;
  live_url?: string | null;          // BU live browser URL — embeddable iframe while pending
  last_step_summary?: string | null; // BU lastStepSummary — shows progress while pending
  // Structured output the agent fills in. Any field may be null.
  raw_output?: string | null;
  company_name?: string | null;
  industry?: string | null;
  size?: string | null;              // e.g. "10-50 employees"
  website?: string | null;
  recent_news?: string | null;       // 1-2 sentence summary
  buying_signals?: string | null;
  notes?: string | null;
  error?: string | null;
}

// Normalize a phone number to a canonical key. Strips whitespace, dashes,
// parens, dots. Leaves `+` and digits. Agent Phone gives us E.164 already
// (e.g. "+19787084114") so this is mostly defensive against transcript /
// hand-entered variants.
export function normalizePhone(s: string | null | undefined): string | null {
  if (!s) return null;
  const cleaned = s.replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  // If 11 digits and starts with 1, normalize to +1NNNNNNNNNN.
  if (/^1\d{10}$/.test(cleaned)) return `+${cleaned}`;
  // If 10 digits and looks US, assume +1.
  if (/^\d{10}$/.test(cleaned)) return `+1${cleaned}`;
  // If already has + and at least 8 digits, keep.
  if (/^\+\d{8,}$/.test(cleaned)) return cleaned;
  // Otherwise return digits-only — better than nothing for indexing.
  return cleaned;
}

function leadKey(normalizedPhone: string): string {
  return `lead:${normalizedPhone}`;
}

export async function getLead(env: Bindings, phone: string): Promise<LeadIndex | null> {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const raw = await env.CALLS.get(leadKey(norm));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LeadIndex;
  } catch {
    return null;
  }
}

export async function saveLead(env: Bindings, lead: LeadIndex): Promise<void> {
  await env.CALLS.put(leadKey(lead.phone), JSON.stringify(lead), {
    expirationTtl: 86400 * 7, // 7d — outlives individual calls (24h) so multi-call leads survive
  });
}

// Append (or upsert) a call onto the lead's call list. Dedupes by call_id.
// Returns the resulting LeadIndex so callers can act on it.
export async function appendCallToLead(
  env: Bindings,
  phone: string,
  call_id: string,
  received_at: string
): Promise<LeadIndex | null> {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const existing = (await getLead(env, norm)) ?? {
    phone: norm,
    calls: [],
    last_seen: received_at,
  };
  // Dedupe + newest-first
  const map = new Map<string, LeadCallEntry>();
  for (const c of existing.calls) map.set(c.call_id, c);
  map.set(call_id, { call_id, received_at });
  const calls = Array.from(map.values()).sort((a, b) =>
    b.received_at.localeCompare(a.received_at)
  );
  const next: LeadIndex = {
    ...existing,
    phone: norm,
    calls,
    last_seen: calls[0]?.received_at ?? received_at,
  };
  await saveLead(env, next);
  return next;
}

// Read all calls for a given phone. Returns null if phone is unparseable or
// no lead exists. Callers typically follow this with N reads of the call
// records themselves (cheap on KV).
export async function getCallsByPhone(
  env: Bindings,
  phone: string
): Promise<LeadCallEntry[] | null> {
  const lead = await getLead(env, phone);
  return lead ? lead.calls : null;
}
