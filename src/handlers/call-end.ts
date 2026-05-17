import type { Bindings, CallEndPayload } from "../types";
import { writeAirtableRow } from "../lib/airtable";
import { postSlackMessage } from "../lib/slack";
import type { CallRecord } from "../lib/render";
import { extractEntitiesGemini } from "../lib/extract-gemini";
import { generateDrafts } from "../lib/drafts-gemini";
import { appendCallToLead } from "../lib/leads";
import productsJson from "../data/products.json";

interface ProductRef {
  sku: string;
  product_url?: string;
}
const catalogIndex = (productsJson as unknown as { products: ProductRef[] }).products;
function findProductUrl(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const hit = catalogIndex.find((p) => p.sku === sku);
  return hit?.product_url ?? null;
}

// Post-call hook for Agent Phone's `agent.call_ended` event.
//
// Side effects (per design doc Operating Decisions §3, §4):
//   1. Write full record to Workers KV (M2 — powers the /call/:id replay page)
//   2. Append row to Airtable Calls table
//   3. Post stub-format summary to Slack with a clickable replay link
//
// All side effects are independent; one failing does not block the others.
// The caller (src/index.ts) always returns 200 OK so Agent Phone doesn't retry.
export async function handleCallEnd(
  payload: CallEndPayload,
  env: Bindings,
  origin: string | null
): Promise<void> {
  const now = new Date().toISOString();
  const p = payload as Record<string, unknown>;

  // ── Defensive field extraction (camelCase + snake_case aliases) ──

  // Use Agent Phone's callId; never the X-Webhook-ID delivery id.
  const callId =
    pickString(p, "callId") ??
    pickString(p, "call_id") ??
    pickString(p, "sessionId") ??
    pickString(p, "session_id") ??
    `synth-${crypto.randomUUID()}`;

  // Caller is `from` in Agent Phone; `to` is OUR (the agent's) number.
  const callerPhone =
    pickString(p, "from") ??
    pickString(p, "caller_phone") ??
    pickString(p, "callerPhone") ??
    pickString(p, "phone") ??
    null;

  const startedAt =
    pickString(p, "startedAt") ??
    pickString(p, "started_at") ??
    null;

  // Transcript: Agent Phone's call_ended sends an array [{role, content}].
  // Older shapes might use a plain string or top-level recentHistory[].
  let transcript: string | null = null;
  if (typeof p.transcript === "string") {
    transcript = p.transcript;
  } else if (Array.isArray(p.transcript)) {
    transcript = (p.transcript as unknown[])
      .map((m) => {
        const msg = m as Record<string, unknown>;
        const role = pickString(msg, "role") ?? "?";
        const content =
          pickString(msg, "content") ??
          pickString(msg, "text") ??
          pickString(msg, "message") ??
          "";
        return `${role}: ${content}`;
      })
      .join("\n");
  } else if (Array.isArray(p.recentHistory)) {
    transcript = (p.recentHistory as unknown[])
      .map((m) => {
        const msg = m as Record<string, unknown>;
        const role = pickString(msg, "role") ?? pickString(msg, "direction") ?? "?";
        const content = pickString(msg, "content") ?? pickString(msg, "text") ?? "";
        return `${role}: ${content}`;
      })
      .join("\n");
  }

  // Agent Phone-provided extras (great for demo Slack message).
  const agentSummary = pickString(p, "summary");
  const sentiment = pickString(p, "userSentiment");
  const callSuccessful =
    typeof p.callSuccessful === "boolean" ? p.callSuccessful : null;
  const durationSeconds =
    typeof p.durationSeconds === "number" ? p.durationSeconds : null;

  // ── Replay URL (M2) ──
  // Derived from the inbound request's origin so it works for both ngrok
  // tunnels and workers.dev deploys without per-env config.
  const replayUrl = origin ? `${origin}/call/${encodeURIComponent(callId)}` : null;

  // ── 1. KV write (write FIRST so the URL is live when Slack message arrives) ──
  // The replay page handler (GET /call/:id) reads back this exact record.
  const slackPreview = buildSlackText({
    now,
    durationSeconds,
    sentiment,
    callSuccessful,
    callerPhone,
    agentSummary,
    transcript,
    replayUrl,
  });
  const record: CallRecord = {
    call_id: callId,
    received_at: now,
    payload: payload as Record<string, unknown>,
    slack_text: slackPreview,
    replay_url: replayUrl,
    state: "new_lead",
  };
  try {
    // 24h TTL — long enough for demo + post-mortem; we're not storing forever.
    await env.CALLS.put(callId, JSON.stringify(record), { expirationTtl: 86400 });
    console.log("[call-end] kv write OK call_id=", callId);
  } catch (err) {
    console.error("[call-end] kv write failed:", err);
  }

  // ── 1.5. Lead index — phone -> calls[] ─────────────────────────────
  // Lets the cockpit show a "Lead workspace" view that aggregates every
  // touchpoint we've had with the same caller, not just this single call.
  // Lead records have a longer TTL (7d) than call records (24h) so the
  // history survives even as individual calls expire.
  if (callerPhone) {
    try {
      await appendCallToLead(env, callerPhone, callId, now);
      console.log("[call-end] lead index updated for", callerPhone);
    } catch (err) {
      console.warn("[call-end] lead index update failed:", err);
    }
  }

  // ── 1a. Gemini entity extraction (M3) ─────────────────────────────
  // Runs AFTER initial KV write so the replay page is already loadable.
  // Result is merged back into the same KV record. This makes the replay
  // page's qualification card (tier/score/SKU/persona) authoritative —
  // way better than the regex extractor.
  try {
    const entities = await extractEntitiesGemini(
      env,
      payload as Record<string, unknown>
    );
    if (entities) {
      record.entities = entities;
      await env.CALLS.put(callId, JSON.stringify(record), { expirationTtl: 86400 });
      console.log(
        `[call-end] gemini extracted tier=${entities.qual_tier} score=${entities.qual_score} sku=${entities.recommended_sku}`
      );

      // ── 1b. M4: AI copilot drafts (sales rep reviews + sends) ──
      // Generate 3 outbound artifacts in one Gemini call: customer SMS,
      // supplier RFQ (Chinese), and internal briefing. These appear in the
      // dashboard awaiting human approval.
      try {
        const drafts = await generateDrafts(env, {
          callId,
          transcript: transcript ?? "",
          entities,
          callerPhone,
          productUrl: findProductUrl(entities.recommended_sku),
        });
        if (drafts) {
          record.drafts = drafts;
          record.drafts_generated_at = new Date().toISOString();
          // Stays "new_lead" — drafts are part of new_lead until sales sends them.
          // Once sales sends all 3, computeState auto-advances to outreach_sent.
          record.state = "new_lead";
          await env.CALLS.put(callId, JSON.stringify(record), { expirationTtl: 86400 });
          console.log("[call-end] 3 drafts generated for", callId);
        }
      } catch (err) {
        console.error("[call-end] drafts generation failed:", err);
      }
    }
  } catch (err) {
    console.error("[call-end] gemini extraction failed:", err);
  }

  // ── 2. Airtable write ──────────────────────────────────────────────
  const airtableFields: Record<string, unknown> = {
    call_id: callId,
    received_at: now,
    raw_payload: JSON.stringify(payload, null, 2),
  };
  if (callerPhone) airtableFields.caller_phone = callerPhone;
  if (startedAt) airtableFields.started_at = startedAt;
  if (transcript !== null) airtableFields.transcript = transcript;

  try {
    await writeAirtableRow(env, airtableFields);
    console.log("[call-end] airtable write OK call_id=", callId);
  } catch (err) {
    console.error("[call-end] airtable write failed:", err);
  }

  // ── 3. Slack post ──
  const slackText = buildSlackText({
    now,
    durationSeconds,
    sentiment,
    callSuccessful,
    callerPhone,
    agentSummary,
    transcript,
    replayUrl,
  });

  try {
    await postSlackMessage(env, slackText);
    console.log("[call-end] slack post OK");
  } catch (err) {
    console.error("[call-end] slack post failed:", err);
  }
}

function buildSlackText(args: {
  now: string;
  durationSeconds: number | null;
  sentiment: string | null;
  callSuccessful: boolean | null;
  callerPhone: string | null;
  agentSummary: string | null;
  transcript: string | null;
  replayUrl: string | null;
}): string {
  const {
    now,
    durationSeconds,
    sentiment,
    callSuccessful,
    callerPhone,
    agentSummary,
    transcript,
    replayUrl,
  } = args;

  const phoneForSlack = callerPhone ?? "unknown";
  const durationStr = durationSeconds !== null ? ` (${durationSeconds.toFixed(1)}s)` : "";
  const sentimentStr = sentiment ? ` sentiment=${sentiment}` : "";
  const successStr =
    callSuccessful !== null ? ` successful=${callSuccessful}` : "";

  const bodyLine = agentSummary
    ? `Summary: ${agentSummary.slice(0, 300)}`
    : `Transcript: ${transcript ? transcript.slice(0, 200) : "(none)"}`;

  const replayLink = replayUrl ? ` — <${replayUrl}|View replay>` : "";

  return `📞 Call ended at ${now}${durationStr}${sentimentStr}${successStr}. Caller: ${phoneForSlack}. ${bodyLine}${replayLink}`;
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}
