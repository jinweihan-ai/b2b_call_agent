import type { Bindings } from "../types";
import { renderReplayPage, type CallRecord } from "../lib/render";
import {
  getLead,
  saveLead,
  normalizePhone,
  type LeadIndex,
} from "../lib/leads";
import {
  getResearchTask,
  classifyStatus,
  parseResearchOutput,
} from "../lib/browser-use";

// GET /person/:phone — the lead workspace.
//
// One URL per real customer (keyed by normalized phone). The page reads
// every call we've seen from that phone, picks the newest as the "primary"
// (drives the brief snapshot + action buttons), and renders all calls'
// transcripts inline in the timeline.
//
// /call/:id is still a valid alias; it 302s to here when the lead can be
// resolved from the phone.
export async function handlePerson(
  rawPhone: string,
  env: Bindings,
  query?: URLSearchParams
): Promise<Response> {
  const phone = normalizePhone(rawPhone);
  if (!phone) {
    return new Response(notFoundHtml(rawPhone, "phone is not parseable"), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  let lead = await getLead(env, phone);
  if (!lead || lead.calls.length === 0) {
    return new Response(notFoundHtml(phone, "no calls indexed for this phone"), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // Lazy-poll the Browser Use research session if it's still pending. Same
  // pattern as /call/:id used to have — at most one external call per render,
  // hard 5s timeout. Updates the lead in KV when state changes.
  if (lead.research && lead.research.status === "pending") {
    const r = lead.research;
    const poll = await getResearchTask(env, r.task_id);
    if (poll.ok) {
      const s = poll.session;
      const next = classifyStatus(s.status);
      if (next === "done") {
        const parsed = parseResearchOutput(s.output);
        const failed = s.isTaskSuccessful === false;
        lead.research = {
          ...r,
          status: failed ? "failed" : "done",
          finished_at: new Date().toISOString(),
          last_step_summary: s.lastStepSummary ?? r.last_step_summary ?? null,
          raw_output:
            s.output === undefined || s.output === null
              ? null
              : typeof s.output === "string"
              ? s.output
              : JSON.stringify(s.output),
          company_name: parsed?.company_name ?? null,
          industry: parsed?.industry ?? null,
          size: parsed?.size ?? null,
          website: parsed?.website ?? null,
          recent_news: parsed?.recent_news ?? null,
          buying_signals: parsed?.buying_signals ?? null,
          notes: parsed?.notes ?? null,
          error: failed ? "Agent reported task unsuccessful" : null,
        };
        await saveLead(env, lead);
      } else if (next === "failed") {
        lead.research = {
          ...r,
          status: "failed",
          finished_at: new Date().toISOString(),
          error: `Browser Use status=${s.status}`,
        };
        await saveLead(env, lead);
      } else if (s.lastStepSummary && s.lastStepSummary !== r.last_step_summary) {
        lead.research = { ...r, last_step_summary: s.lastStepSummary };
        await saveLead(env, lead);
      }
    }
  }

  // Load every call we've seen for this lead — newest first (lead.calls is
  // already kept in that order by appendCallToLead).
  const records: CallRecord[] = [];
  for (const c of lead.calls) {
    const raw = await env.CALLS.get(c.call_id);
    if (!raw) continue;
    try {
      records.push(JSON.parse(raw) as CallRecord);
    } catch {
      /* skip malformed */
    }
  }
  if (records.length === 0) {
    return new Response(notFoundHtml(phone, "lead index points at calls but none could be read"), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
  const primary = records[0];

  // Lazy recording-URL discovery — only for the primary call. Other calls
  // either already have a recording URL stored or we skip; fetching for
  // every historical call would slow the page render.
  await maybeRefreshRecordingUrl(primary, env);

  const html = renderReplayPage(primary, query, lead, records);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function maybeRefreshRecordingUrl(rec: CallRecord, env: Bindings): Promise<void> {
  const looksLikeAgentPhoneId = /^cmp[a-z0-9]/i.test(rec.call_id);
  if (rec.recording_url || !env.AGENT_PHONE_API_KEY || !looksLikeAgentPhoneId) return;
  const apiBase = env.AGENT_PHONE_API_BASE || "https://api.agentphone.ai/v1";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const resp = await fetch(`${apiBase}/calls/${encodeURIComponent(rec.call_id)}`, {
      headers: { Authorization: `Bearer ${env.AGENT_PHONE_API_KEY}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return;
    const j = (await resp.json()) as Record<string, unknown>;
    const available = j.recordingAvailable === true;
    const url = typeof j.recordingUrl === "string" ? j.recordingUrl : null;
    if (available && url) {
      rec.recording_url = url;
      await env.CALLS.put(rec.call_id, JSON.stringify(rec), { expirationTtl: 86400 });
    }
  } catch {
    clearTimeout(timer);
    /* swallow — page still renders without audio */
  }
}

function notFoundHtml(phone: string, reason: string): string {
  const safe = phone.replace(/[<>&"]/g, "_");
  const safeReason = reason.replace(/[<>&"]/g, "_");
  return `<!doctype html><meta charset="utf-8"><title>Person not found</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;color:#1c1917}h1{font-size:20px}p{color:#78716c}a{color:#0f766e;}</style>
<h1>No person record for <code>${safe}</code></h1>
<p>${safeReason}</p>
<p><a href="/">← Back to cockpit</a></p>`;
}

// Helper for callers that need to redirect /call/:id → /person/:phone.
// Returns null if the phone can't be resolved.
export function leadPhoneForCall(rec: CallRecord): string | null {
  const d = (rec.payload?.data ?? rec.payload ?? {}) as Record<string, unknown>;
  const phoneRaw =
    (typeof d.from === "string" ? d.from : null) ??
    (typeof d.caller_phone === "string" ? (d.caller_phone as string) : null);
  return normalizePhone(phoneRaw);
}

// Used by leads metadata API to expose just the lead snapshot (not the full
// page). Kept here so /person and its small JSON sidekicks live together.
export async function handlePersonJson(
  rawPhone: string,
  env: Bindings
): Promise<Response> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return new Response("invalid phone", { status: 400 });
  const lead = await getLead(env, phone);
  if (!lead) return new Response("not found", { status: 404 });
  const body: LeadIndex = lead;
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json" },
  });
}
