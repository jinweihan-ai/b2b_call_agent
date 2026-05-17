import type { Bindings } from "../types";
import { renderReplayPage, type CallRecord } from "../lib/render";
import { getLead, saveLead, normalizePhone, type LeadIndex } from "../lib/leads";
import {
  getResearchTask,
  classifyStatus,
  parseResearchOutput,
} from "../lib/browser-use";

// GET /call/:id — public replay page + M4 action panel rendering.
//
// M2.1 enhancement: lazily fetch the recording URL from Agent Phone's REST
// API on the first page load after a call.
// M4: also renders the action panel where the sales rep reviews + sends
// AI-drafted outbound messages. Query string (?ok=... or ?err=...) shows
// status banners after action POSTs redirect back here.
export async function handleReplay(
  callId: string,
  env: Bindings,
  query?: URLSearchParams
): Promise<Response> {
  const raw = await env.CALLS.get(callId);
  if (!raw) {
    return new Response(notFoundHtml(callId), {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  let rec: CallRecord;
  try {
    rec = JSON.parse(raw) as CallRecord;
  } catch {
    return new Response(errorHtml(callId, "stored record is malformed"), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // M6: /call/:id is now a legacy alias. When the caller's phone is
  // resolvable, redirect to /person/:phone — that's the canonical view.
  // Synthetic test calls without a phone fall through to the old single-call
  // render so we don't break dev/debug workflows.
  const dRedirect = (rec.payload?.data ?? rec.payload ?? {}) as Record<string, unknown>;
  const phoneRaw =
    (typeof dRedirect.from === "string" ? dRedirect.from : null) ??
    (typeof dRedirect.caller_phone === "string" ? (dRedirect.caller_phone as string) : null);
  const normalized = normalizePhone(phoneRaw);
  if (normalized) {
    const qs = query?.toString() ?? "";
    const target = `/person/${encodeURIComponent(normalized)}${qs ? `?${qs}` : ""}`;
    return new Response(null, {
      status: 302,
      headers: { Location: target, "cache-control": "no-store" },
    });
  }

  // Lazy recording-URL discovery — only for callIds that look like real
  // Agent Phone IDs (prefix "cmp"). Synthetic test IDs (M4_TEST_*, etc.)
  // and stale IDs skip the API call entirely — Agent Phone's /v1/calls/{id}
  // can hang up to 2 minutes on bogus IDs, blocking the whole page render.
  const looksLikeAgentPhoneId = /^cmp[a-z0-9]/i.test(callId);
  if (!rec.recording_url && env.AGENT_PHONE_API_KEY && looksLikeAgentPhoneId) {
    const apiBase = env.AGENT_PHONE_API_BASE || "https://api.agentphone.ai/v1";
    const detailUrl = `${apiBase}/calls/${encodeURIComponent(callId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000); // hard cap 3s
    try {
      const resp = await fetch(detailUrl, {
        headers: { Authorization: `Bearer ${env.AGENT_PHONE_API_KEY}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (resp.ok) {
        const j = (await resp.json()) as Record<string, unknown>;
        const available = j.recordingAvailable === true;
        const url = typeof j.recordingUrl === "string" ? j.recordingUrl : null;
        if (available && url) {
          rec.recording_url = url;
          // Persist for next load — recording URLs are stable per docs.
          await env.CALLS.put(callId, JSON.stringify(rec), {
            expirationTtl: 86400,
          });
          console.log("[replay] recording URL discovered + cached:", callId);
        } else {
          console.log(
            `[replay] recording not yet available for ${callId}: available=${available} url=${!!url}`
          );
        }
      } else {
        console.warn(
          `[replay] /v1/calls/${callId} returned ${resp.status} ${resp.statusText}`
        );
      }
    } catch (err) {
      clearTimeout(timer);
      if ((err as Error).name === "AbortError") {
        console.warn(`[replay] call detail fetch timed out for ${callId} (3s)`);
      } else {
        console.warn("[replay] call detail fetch failed:", err);
      }
    }
  }

  // Resolve the caller's lead record for the page (history aggregation +
  // caller research). Best-effort — if there's no lead yet, the page still
  // renders without the lead-scoped sections.
  const d = (rec.payload?.data ?? rec.payload ?? {}) as Record<string, unknown>;
  const callerPhone =
    (typeof d.from === "string" ? d.from : null) ??
    (typeof d.caller_phone === "string" ? (d.caller_phone as string) : null);
  let lead: LeadIndex | null = callerPhone ? await getLead(env, callerPhone) : null;

  // Lazy-poll Browser Use if a background-check is in flight. Same pattern
  // as the recording-URL discovery above: at most one external API call per
  // page render, with a hard timeout.
  if (lead?.research && lead.research.status === "pending") {
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
          raw_output: s.output === undefined || s.output === null
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
        console.log(
          `[replay] research done for ${lead.phone} success=${!failed} company=${parsed?.company_name ?? "?"}`
        );
      } else if (next === "failed") {
        lead.research = {
          ...r,
          status: "failed",
          finished_at: new Date().toISOString(),
          error: `Browser Use status=${s.status}`,
        };
        await saveLead(env, lead);
        console.warn(`[replay] research failed for ${lead.phone} status=${s.status}`);
      } else if (s.lastStepSummary && s.lastStepSummary !== r.last_step_summary) {
        // Still pending — refresh the human-readable progress hint.
        lead.research = { ...r, last_step_summary: s.lastStepSummary };
        await saveLead(env, lead);
      }
    } else {
      console.warn(`[replay] research poll failed: ${poll.error}`);
    }
  }

  const html = renderReplayPage(rec, query, lead);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function notFoundHtml(callId: string): string {
  const safe = callId.replace(/[<>&"]/g, "_");
  return `<!doctype html><meta charset="utf-8"><title>Call not found</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;color:#1c1917}h1{font-size:20px}p{color:#78716c}</style>
<h1>Call replay not found</h1>
<p>No record for call id <code>${safe}</code>.</p>
<p>This usually means the call hasn't ended yet, or the record has expired from KV.</p>`;
}

function errorHtml(callId: string, msg: string): string {
  const safe = callId.replace(/[<>&"]/g, "_");
  const safeMsg = msg.replace(/[<>&"]/g, "_");
  return `<!doctype html><meta charset="utf-8"><title>Replay error</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 16px;color:#1c1917}h1{font-size:20px}p{color:#78716c}</style>
<h1>Replay error</h1>
<p>Call id <code>${safe}</code>: ${safeMsg}.</p>`;
}
