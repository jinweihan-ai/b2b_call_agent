// M2 replay page renderer. Single-file inline HTML+CSS, no external CDN deps.
// All data comes from the stored CallRecord — pure function, easy to evolve.

import { extractEntities, qualScore, matchProduct } from "./extract";
import productsJson from "../data/products.json";

interface CatalogProduct {
  sku: string;
  name: string;
  type: string;
  power_w: number;
  working_area_mm: [number, number];
  materials: string[];
  max_steel_thickness_mm: number;
  price_usd_range: [number, number];
  lead_time_weeks: number;
  ideal_for: string[];
  product_url?: string;
}
const catalog = productsJson as unknown as { products: CatalogProduct[] };

function findBySku(sku: string | null): CatalogProduct | null {
  if (!sku) return null;
  return catalog.products.find((p) => p.sku === sku) ?? null;
}

export interface CallRecord {
  call_id: string;
  received_at: string; // worker timestamp
  payload: Record<string, unknown>; // verbatim Agent Phone call_ended payload
  slack_text: string | null; // the message we posted (or null if Slack disabled)
  replay_url: string | null; // the url of THIS page (for sharing/preview)
  // M2.1: recording URL discovered via Agent Phone REST API (lazy fetch on
  // first replay page load when recording add-on is enabled).
  recording_url?: string | null;
  // M3: Gemini-extracted entities — authoritative replacement for the regex
  // path. Set at call-end time, used by the replay page.
  entities?: import("./extract-gemini").GeminiEntities | null;
  // M4: "AI copilot + human signoff" — 3 AI-drafted outbound artifacts
  // awaiting sales rep review. State machine tracks pipeline progress.
  state?: CallState;
  drafts?: CallDrafts | null;
  drafts_generated_at?: string;
  actions?: CallActions;
}

// M7 "first-24h response system" state machine. We deliberately stop the
// AI's responsibility at the moment the sales rep has the briefing + drafts
// + research in hand. Past that point the deal lives in the customer's own
// CRM (HubSpot / Salesforce / Feishu / etc.) — we don't pretend to track
// quote / negotiation / close because we can't actually observe those.
//
// Old per-call states (quoted / negotiating / closed_won / closed_lost /
// nurture) collapse to `archived` via normalizeState. Old KV records still
// load and render; they just show in the Archived column.
export type CallState =
  | "new_lead"        // AI qualified; sales rep hasn't sent outreach yet
  | "outreach_sent"   // 3 AI drafts approved + sent; ready for sales rep to take over
  | "archived";       // Handed off to the customer's own CRM (or dismissed as bad fit)

// Legacy states the dashboard still has to read from old KV records.
export type LegacyCallState =
  | "qualified"        // → New Lead
  | "drafts_ready"     // → New Lead
  | "partially_sent"   // → New Lead
  | "all_sent"         // → Outreach Sent
  | "quoted"           // → Archived (was a downstream stage in v0.1)
  | "negotiating"      // → Archived (was a downstream stage in v0.1)
  | "won" | "closed_won"     // → Archived
  | "lost" | "closed_lost"   // → Archived
  | "nurture";         // → Archived

export function normalizeState(s: string | undefined): CallState {
  switch (s) {
    case "new_lead":
    case "outreach_sent":
    case "archived":
      return s as CallState;
    case "all_sent":
      return "outreach_sent";
    case "quoted":
    case "negotiating":
    case "won":
    case "closed_won":
    case "lost":
    case "closed_lost":
    case "nurture":
      return "archived";
    // qualified / drafts_ready / partially_sent / undefined → New Lead
    default:
      return "new_lead";
  }
}

export interface CallDrafts {
  customer_sms: string; // Plain ASCII; sent via Agent Phone outbound
  supplier_rfq: string; // Chinese text; sent to #sourcing-china Slack
  briefing: string;     // Markdown for the US-side sales rep
}

export interface CallActions {
  customer_sms?: {
    sent_at: string;
    sent_text: string; // exact text the sales rep approved (may have edited the draft)
    message_id?: string; // Agent Phone message id
  };
  supplier_rfq?: {
    sent_at: string;
    sent_text: string;
  };
  briefing?: {
    acked_at: string;
  };
  // Sales rep marked this lead as "handed off to my CRM" — the AI's job is
  // done. May or may not have completed all 3 outreach actions first.
  archived_at?: string;
  archived_note?: string;
  // Time-in-stage tracking (set whenever state changes).
  stage_entered_at?: string;
  // Legacy fields preserved for old KV records that still need to render.
  // Not written by current handlers. v0.2 dropped quote / customer_response /
  // outcome tracking — see CallState comment.
  quote?: {
    factory_confirmed_at: string;
    factory_price_usd?: number;
    factory_lead_time_weeks?: number;
    quote_sent_to_customer_at?: string;
    notes?: string;
  };
  customer_response?: {
    received_at: string;
    sentiment?: "positive" | "negotiating" | "objecting";
    notes?: string;
  };
  outcome?: "won" | "lost" | "nurture";
  outcome_at?: string;
  outcome_note?: string;
}

const SAFE_CHARS: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => SAFE_CHARS[ch] || ch);
}

interface TranscriptEntry {
  role: string;
  content: string;
}

function getTranscriptArray(payload: Record<string, unknown>): TranscriptEntry[] {
  const d = (payload.data ?? payload) as Record<string, unknown>;
  const t = d.transcript;
  if (Array.isArray(t)) {
    return (t as Array<Record<string, unknown>>)
      .map((m) => ({
        role: String(m.role ?? "?"),
        content: String(m.content ?? ""),
      }))
      .filter((m) => m.content.length > 0);
  }
  return [];
}

function getString(payload: Record<string, unknown>, key: string): string | null {
  const d = (payload.data ?? payload) as Record<string, unknown>;
  const v = d[key] ?? payload[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function getNumber(payload: Record<string, unknown>, key: string): number | null {
  const d = (payload.data ?? payload) as Record<string, unknown>;
  const v = d[key] ?? payload[key];
  return typeof v === "number" ? v : null;
}

function getBool(payload: Record<string, unknown>, key: string): boolean | null {
  const d = (payload.data ?? payload) as Record<string, unknown>;
  const v = d[key] ?? payload[key];
  return typeof v === "boolean" ? v : null;
}

// Recording URL detection — Agent Phone uses `data.recordingUrl` (camelCase
// per docs) when the recording add-on is enabled on the Billing page. We
// accept a few aliases just in case.
function getRecordingUrl(payload: Record<string, unknown>): string | null {
  const d = (payload.data ?? payload) as Record<string, unknown>;
  for (const k of ["recordingUrl", "recording_url", "recordingURL", "audioUrl", "audio_url"]) {
    const v = d[k];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  // Nested shape: data.recording.url
  const rec = d.recording;
  if (rec && typeof rec === "object") {
    const ru = (rec as Record<string, unknown>).url;
    if (typeof ru === "string" && /^https?:\/\//i.test(ru)) return ru;
  }
  return null;
}

import type { LeadIndex } from "./leads";

export function renderReplayPage(
  rec: CallRecord,
  query?: URLSearchParams,
  lead?: LeadIndex | null,
  allCalls?: CallRecord[]
): string {
  const p = rec.payload;
  const transcript = getTranscriptArray(p);
  const transcriptText = transcript.map((m) => `${m.role}: ${m.content}`).join("\n");

  // Prefer Gemini-extracted entities (M3) over the regex extractor (M2 fallback).
  // Gemini handles ASR drift + production-volume-vs-budget disambiguation +
  // picks recommended SKU with rationale.
  const gem = rec.entities ?? null;
  const regexEntities = gem ? null : extractEntities(transcriptText);

  // Normalize into a single "view model" the render block uses:
  const material = gem?.material ?? regexEntities?.material ?? null;
  const thicknessMm = gem?.thickness_mm ?? regexEntities?.thickness_mm ?? null;
  const budgetMin = gem?.budget_usd_min ?? regexEntities?.budget_usd?.min ?? null;
  const budgetMax = gem?.budget_usd_max ?? regexEntities?.budget_usd?.max ?? null;
  const timelineWeeks = gem?.timeline_weeks ?? regexEntities?.timeline_weeks ?? null;
  const score = gem?.qual_score ?? (regexEntities ? qualScore(regexEntities) : 0);
  const tierFromGemini = gem?.qual_tier ?? null;
  const application = gem?.application ?? null;
  const persona = gem?.buyer_persona ?? null;
  const concerns = gem?.concerns ?? [];
  const recommendationReason = gem?.recommended_reason ?? null;
  // Pick product: Gemini's chosen SKU > regex catalog match
  const product = gem?.recommended_sku
    ? findBySku(gem.recommended_sku)
    : regexEntities
    ? matchProduct(regexEntities)
    : null;

  const callerPhone = getString(p, "from") ?? "—";
  const startedAt = getString(p, "startedAt") ?? rec.received_at;
  const duration = getNumber(p, "durationSeconds");
  const disconnect = getString(p, "disconnectionReason") ?? "—";
  const summary = getString(p, "summary");
  const sentiment = getString(p, "userSentiment");
  const callSuccessful = getBool(p, "callSuccessful");
  const agentId = getString(p, "agentId") ?? getString(p, "agent_id");
  // Prefer the explicit recording_url set by the replay handler (after
  // /v1/calls/{id} API check) over any URL embedded in the original payload.
  const recordingUrl = rec.recording_url ?? getRecordingUrl(p);

  const tierColor =
    score >= 75 ? "#16a34a" : score >= 50 ? "#ca8a04" : score >= 25 ? "#ea580c" : "#dc2626";
  // Prefer Gemini's qual_tier string; fall back to threshold-mapped label.
  const tierLabel =
    tierFromGemini && /^(hot|warm|cool|cold)$/i.test(tierFromGemini)
      ? tierFromGemini.charAt(0).toUpperCase() + tierFromGemini.slice(1).toLowerCase()
      : score >= 75 ? "Hot" : score >= 50 ? "Warm" : score >= 25 ? "Cool" : "Cold";

  // Count signals captured for the "N of 4 signals" caption.
  const signalsCaptured = [material, thicknessMm !== null, budgetMin !== null, timelineWeeks !== null].filter(Boolean).length;

  const html = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Call ${escapeHtml(rec.call_id)} — b2b-call-agent</title>
<style>
  :root {
    --bg: #f5f5f4;
    --card: #ffffff;
    --border: #e7e5e4;
    --text: #1c1917;
    --muted: #78716c;
    --accent: #0f766e;
    --agent: #f0fdfa;
    --agent-border: #99f6e4;
    --user: #fff7ed;
    --user-border: #fed7aa;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, sans-serif;
    font-size: 15px;
    line-height: 1.5;
    padding: 24px 16px 64px;
  }
  .container { max-width: 1100px; margin: 0 auto; }
  header {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px 24px;
    margin-bottom: 24px;
    display: flex;
    flex-wrap: wrap;
    gap: 24px;
    align-items: center;
    justify-content: space-between;
  }
  .h-left h1 {
    margin: 0 0 4px;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .h-left .sub {
    color: var(--muted);
    font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .badges { display: flex; gap: 8px; flex-wrap: wrap; }
  .badge {
    background: #f5f5f4;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 4px 12px;
    font-size: 12px;
    color: var(--muted);
  }
  .badge.pos { background: #dcfce7; color: #166534; border-color: #86efac; }
  .badge.neg { background: #fee2e2; color: #991b1b; border-color: #fca5a5; }
  .grid {
    display: grid;
    grid-template-columns: 1.4fr 1fr;
    gap: 24px;
  }
  @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px 24px;
    margin-bottom: 24px;
  }
  .card h2 {
    margin: 0 0 16px;
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .bubble {
    border-radius: 14px;
    padding: 10px 14px;
    margin-bottom: 10px;
    max-width: 85%;
    border: 1px solid;
    font-size: 14px;
  }
  .bubble.agent {
    background: var(--agent);
    border-color: var(--agent-border);
    margin-right: auto;
  }
  .bubble.user {
    background: var(--user);
    border-color: var(--user-border);
    margin-left: auto;
    text-align: right;
  }
  .bubble .who {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .ent-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .ent {
    background: #fafaf9;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 14px;
  }
  .ent .lbl {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .ent .val {
    font-size: 16px;
    font-weight: 600;
    margin-top: 2px;
  }
  .ent .val.miss { color: #a8a29e; font-weight: 400; font-style: italic; font-size: 14px; }
  .score-row {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
  }
  .score-circle {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    background: ${tierColor};
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 22px;
    flex-shrink: 0;
  }
  .score-label {
    font-weight: 600;
    color: ${tierColor};
    font-size: 18px;
  }
  .score-note { font-size: 13px; color: var(--muted); }
  .product {
    background: linear-gradient(135deg, #fefce8 0%, #fef9c3 100%);
    border: 1px solid #fde047;
    border-radius: 10px;
    padding: 16px;
  }
  .product .sku {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: var(--muted);
  }
  .product .name { font-size: 17px; font-weight: 600; margin: 4px 0 12px; }
  .product .specs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px 16px;
    font-size: 13px;
  }
  .product .specs .k { color: var(--muted); }
  .slack-preview {
    background: #f8fafc;
    border-left: 4px solid #4a154b;
    border-radius: 4px;
    padding: 12px 16px;
    font-size: 13px;
    color: #1e293b;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .summary-card {
    background: linear-gradient(135deg, #ecfeff 0%, #cffafe 100%);
    border: 1px solid #67e8f9;
    border-radius: 10px;
    padding: 16px;
    font-size: 14px;
    color: #164e63;
  }
  .footer {
    margin-top: 32px;
    text-align: center;
    color: var(--muted);
    font-size: 12px;
  }
  .stub-note {
    display: inline-block;
    margin-top: 8px;
    font-size: 11px;
    color: var(--muted);
    font-style: italic;
  }
  .audio-card {
    background: linear-gradient(135deg, #f0fdfa 0%, #ccfbf1 100%);
    border: 1px solid #5eead4;
    border-radius: 12px;
    padding: 16px 24px;
    margin-bottom: 24px;
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }
  .audio-card .lbl-block {
    flex: 0 0 auto;
  }
  .audio-card .lbl-block .ttl {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
  }
  .audio-card .lbl-block .sub {
    font-size: 12px;
    color: var(--muted);
    margin-top: 2px;
  }
  .audio-card audio {
    flex: 1 1 280px;
    min-width: 280px;
    height: 40px;
  }
  .audio-card a.dl {
    font-size: 12px;
    color: var(--accent);
    text-decoration: none;
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 4px 10px;
  }
  .audio-card a.dl:hover { background: var(--accent); color: #fff; }
  .audio-banner {
    background: #fffbeb;
    border: 1px dashed #fcd34d;
    border-radius: 10px;
    padding: 12px 18px;
    margin-bottom: 24px;
    font-size: 13px;
    color: #78350f;
    line-height: 1.6;
  }
  .audio-banner code {
    background: #fef3c7;
    padding: 1px 5px;
    border-radius: 3px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  /* ── M4 action panel ── */
  .action-panel {
    margin-bottom: 24px;
  }
  .state-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
    padding: 10px 16px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 10px;
    flex-wrap: wrap;
  }
  .state-bar .state-pill {
    padding: 4px 12px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .state-bar .back-link {
    color: var(--accent);
    text-decoration: none;
    font-size: 13px;
  }
  .state-bar .back-link:hover { text-decoration: underline; }
  .action-card {
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 14px;
  }
  .action-card.done {
    background: #f0fdf4;
    border-color: #86efac;
  }
  .action-card .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    gap: 12px;
  }
  .action-card .head .ttl {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .action-card .head .status {
    font-size: 11px;
    color: var(--muted);
  }
  .action-card.done .head .status { color: #166534; font-weight: 600; }
  .action-card textarea {
    width: 100%;
    min-height: 90px;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 12px;
    font-family: inherit;
    font-size: 13px;
    line-height: 1.5;
    resize: vertical;
    background: #fafaf9;
  }
  .action-card textarea:focus {
    outline: 2px solid var(--accent);
    outline-offset: -1px;
    background: #fff;
  }
  .action-card .controls {
    display: flex;
    gap: 8px;
    margin-top: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .action-card button {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .action-card button:hover { background: #115e59; }
  .action-card button.secondary {
    background: #fff;
    color: var(--accent);
    border: 1px solid var(--accent);
  }
  .action-card button.secondary:hover { background: var(--accent); color: #fff; }
  .action-card .sent-info {
    font-size: 12px;
    color: #166534;
    background: #dcfce7;
    border: 1px solid #86efac;
    border-radius: 6px;
    padding: 6px 10px;
    margin-top: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .action-card .brief-md {
    background: #fafaf9;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 16px;
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    font-family: inherit;
  }
  .action-card .brief-md strong { color: var(--accent); }
  .outcome-bar {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 12px 16px;
    background: #fff;
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 24px;
    flex-wrap: wrap;
  }
  .outcome-bar form { display: inline; }
  .outcome-bar .label { font-size: 13px; color: var(--muted); margin-right: 12px; }
  .outcome-bar button {
    border: none;
    border-radius: 8px;
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .outcome-bar button.won { background: #16a34a; color: #fff; }
  .outcome-bar button.lost { background: #fff; color: #991b1b; border: 1px solid #991b1b; }
  .outcome-bar button.nurture { background: #fff; color: #365314; border: 1px solid #65a30d; }
  .outcome-bar button.won:hover { background: #15803d; }
  .outcome-bar button.lost:hover { background: #991b1b; color: #fff; }
  .outcome-bar button.nurture:hover { background: #65a30d; color: #fff; }
  /* M5 transition controls */
  .transition-bar {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 14px 18px;
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 10px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .transition-bar .label {
    font-size: 13px;
    color: #92400e;
    font-weight: 500;
  }
  .transition-row {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 8px;
  }
  .transition-bar input[type=number],
  .transition-bar input[type=text],
  .transition-bar select {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 13px;
    font-family: inherit;
    flex: 1 1 140px;
    min-width: 140px;
  }
  .transition-bar input[type=text] {
    width: 100%;
    margin-top: 4px;
  }
  .transition-bar button.primary {
    background: #f59e0b;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 8px 18px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .transition-bar button.primary:hover { background: #d97706; }
  /* Stage info read-back cards */
  .stage-info-card {
    background: #f0fdf4;
    border: 1px solid #86efac;
    border-radius: 8px;
    padding: 10px 14px;
    margin-bottom: 12px;
    font-size: 13px;
    color: #166534;
    line-height: 1.55;
  }
  .stage-info-card strong { font-weight: 600; }
  .stage-info-card em { font-style: italic; color: #15803d; }
  .outcome-final {
    padding: 12px 16px;
    background: #f0fdf4;
    border: 1px solid #86efac;
    border-radius: 10px;
    margin-bottom: 24px;
    font-size: 14px;
    color: #166534;
  }
  .outcome-final.lost {
    background: #fef2f2;
    border-color: #fca5a5;
    color: #991b1b;
  }
  .notice {
    padding: 10px 14px;
    border-radius: 8px;
    margin-bottom: 16px;
    font-size: 13px;
  }
  .notice.ok { background: #dcfce7; border: 1px solid #86efac; color: #166534; }
  .notice.err { background: #fee2e2; border: 1px solid #fca5a5; color: #7f1d1d; }
  /* Lead history banner — other calls from the same caller */
  .lead-banner {
    background: #fafaf9;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 14px;
    margin-bottom: 12px;
    font-size: 13px;
    color: var(--muted);
    display: flex;
    flex-wrap: wrap;
    gap: 8px 12px;
    align-items: center;
  }
  .lead-banner .label {
    font-weight: 600;
    color: var(--text);
  }
  .lead-banner a {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px dashed currentColor;
  }
  .lead-banner a.current { color: var(--muted); font-weight: 600; border-bottom: none; }
  /* Caller research card (Browser Use background check) */
  .research-card {
    background: #fff;
    border: 1px solid var(--border);
    border-left: 3px solid #8b5cf6;
    border-radius: 10px;
    padding: 14px 16px;
    margin-bottom: 14px;
  }
  .research-card.pending { border-left-color: #f59e0b; background: #fffbeb; }
  .research-card.done    { border-left-color: #10b981; background: #f0fdf4; }
  .research-card.failed  { border-left-color: #dc2626; background: #fef2f2; }
  .research-card .head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; margin-bottom: 8px;
  }
  .research-card .head .ttl { font-weight: 600; font-size: 14px; }
  .research-card .head .status { font-size: 12px; color: var(--muted); }
  .research-card .pitch {
    font-size: 13px; color: var(--muted); margin-bottom: 8px;
  }
  .research-card .grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    font-size: 13px;
    margin: 0;
  }
  .research-card .grid dt { color: var(--muted); font-weight: 500; }
  .research-card .grid dd { margin: 0; color: var(--text); }
  .research-card a { color: var(--accent); text-decoration: none; border-bottom: 1px dashed currentColor; }
  .research-card .progress {
    margin-top: 6px;
    font-size: 12px;
    color: #92400e;
    font-style: italic;
  }
  .research-card .pending-row {
    display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
    margin-top: 6px;
  }
  .research-card form { display: inline-block; }
  .research-card button.primary {
    background: #8b5cf6;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .research-card button.primary:hover { background: #7c3aed; }
  .research-card button.secondary {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12px;
    cursor: pointer;
  }
  /* ── M6 IA: top controls bar (state + back + outcome) ─────────────── */
  .top-controls {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 16px;
  }
  .top-controls .back-link {
    color: var(--muted);
    text-decoration: none;
    font-size: 13px;
  }
  .top-controls .back-link:hover { color: var(--accent); }
  .top-controls .state-pill {
    border-radius: 999px;
    padding: 5px 14px;
    font-size: 12px;
    font-weight: 600;
  }
  .top-controls .spacer { flex: 1; }
  .top-controls .meta {
    font-size: 12px;
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  /* ── M6 IA: brief snapshot card (top of page) ────────────────────── */
  .brief-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px 24px;
    margin-bottom: 20px;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 16px 24px;
    align-items: start;
  }
  .brief-ident h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .brief-ident .ident-meta {
    color: var(--muted);
    font-size: 13px;
    margin-top: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .brief-ident .persona-line {
    margin-top: 6px;
    font-size: 13px;
    color: var(--text);
  }
  .brief-tier {
    display: flex;
    flex-direction: column;
    align-items: end;
    gap: 6px;
  }
  .brief-tier .pill {
    color: #fff;
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 13px;
    font-weight: 700;
  }
  .brief-tier .signal-note {
    font-size: 11px;
    color: var(--muted);
  }
  .brief-row {
    grid-column: 1 / -1;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .brief-row .lbl-row {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
  }
  @media (max-width: 700px) { .brief-row .lbl-row { grid-template-columns: repeat(2, 1fr); } }
  .brief-row .cell .lbl {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--muted);
    letter-spacing: 0.06em;
    margin-bottom: 2px;
  }
  .brief-row .cell .val { font-size: 14px; color: var(--text); }
  .brief-row .cell .val.miss { color: #a8a29e; font-style: italic; }
  .brief-row.research {
    background: #ecfdf5;
    border: 1px solid #6ee7b7;
    border-radius: 10px;
    padding: 10px 14px;
    margin-top: 6px;
  }
  .brief-row.research .lbl {
    font-size: 11px;
    color: #047857;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 4px;
  }
  .brief-row.research .body { font-size: 13px; color: #064e3b; line-height: 1.5; }
  .brief-row.research .body a { color: #047857; text-decoration: underline; }
  .brief-row.sku {
    background: #fffbeb;
    border: 1px solid #fcd34d;
    border-radius: 10px;
    padding: 12px 14px;
    margin-top: 6px;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 14px;
    align-items: baseline;
  }
  .brief-row.sku .sku-key {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14px;
    font-weight: 700;
    color: #92400e;
  }
  .brief-row.sku .name { font-size: 13px; color: var(--text); }
  .brief-row.sku .specs {
    grid-column: 1 / -1;
    font-size: 12px;
    color: var(--muted);
    margin-top: 4px;
  }
  .brief-row.sku .reason {
    grid-column: 1 / -1;
    font-size: 12px;
    color: #713f12;
    font-style: italic;
    margin-top: 6px;
  }
  .brief-row.concerns {
    background: #fef2f2;
    border: 1px solid #fca5a5;
    border-radius: 10px;
    padding: 10px 14px;
    margin-top: 6px;
  }
  .brief-row.concerns .lbl {
    font-size: 11px;
    color: #991b1b;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 4px;
  }
  .brief-row.concerns ul {
    margin: 0; padding-left: 18px; font-size: 13px; color: #7f1d1d;
  }
  /* ── M6 IA: two-column grid (timeline | actions) ─────────────────── */
  .ia-grid {
    display: grid;
    grid-template-columns: 1.5fr 1fr;
    gap: 20px;
    margin-bottom: 24px;
  }
  @media (max-width: 900px) { .ia-grid { grid-template-columns: 1fr; } }
  .col-timeline h2, .col-actions h2 {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    margin: 0 0 12px;
  }
  /* ── M6 IA: timeline entries ─────────────────────────────────────── */
  .timeline { display: flex; flex-direction: column; gap: 12px; }
  .timeline-entry {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px 16px;
  }
  .timeline-entry.current {
    border-left: 3px solid var(--accent);
  }
  .timeline-entry .row {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 12px; margin-bottom: 6px;
  }
  .timeline-entry .ttl {
    font-size: 13px;
    font-weight: 600;
  }
  .timeline-entry .when {
    font-size: 11px;
    color: var(--muted);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .timeline-entry .body {
    font-size: 13px;
    color: var(--text);
    line-height: 1.5;
  }
  .timeline-entry .body audio { width: 100%; margin: 8px 0; }
  .timeline-entry .body a.entry-link {
    color: var(--accent); text-decoration: none;
    border-bottom: 1px dashed currentColor;
    font-size: 12px;
  }
  .timeline-entry.compact { padding: 10px 14px; }
  .timeline-entry.compact .ttl { font-size: 12px; font-weight: 500; color: var(--muted); }
  .timeline-entry.compact .body { font-size: 12px; color: var(--text); }
  .timeline-entry .preview {
    font-size: 12px;
    color: var(--muted);
    background: #fafaf9;
    border: 1px dashed var(--border);
    border-radius: 6px;
    padding: 6px 10px;
    margin-top: 4px;
    white-space: pre-wrap;
    max-height: 6em;
    overflow: hidden;
  }
  /* ── M6 IA: inline rename form (collapsible) ─────────────────────── */
  .rename-form {
    margin-top: 10px;
    font-size: 12px;
  }
  .rename-form summary {
    color: var(--accent);
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  .rename-form summary::-webkit-details-marker { display: none; }
  .rename-form summary:hover { text-decoration: underline; }
  .rename-form form {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  .rename-form input[type=text] {
    flex: 1;
    min-width: 200px;
    padding: 6px 10px;
    font-size: 13px;
    border: 1px solid var(--border);
    border-radius: 6px;
  }
  .rename-form button {
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    border: none;
    border-radius: 6px;
    cursor: pointer;
  }
  .rename-form button.primary {
    background: var(--accent);
    color: #fff;
  }
  .rename-form button.primary:hover { background: #115e59; }
  .rename-form button.secondary {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--border);
  }
</style>
</head>
<body>
<div class="container">

  ${renderTopControls(rec, query)}

  ${renderBriefCard({
    displayName: lead?.display_name ?? null,
    callerName: gem?.caller_name ?? null,
    callerCompany: gem?.caller_company ?? null,
    callerPhone,
    leadPhoneForUrl: lead?.phone ?? null,
    callCount: lead?.calls.length ?? 1,
    startedAt,
    durationSeconds: duration,
    disconnect,
    sentiment,
    callSuccessful,
    agentId,
    buyerPersona: persona,
    score,
    tierLabel,
    tierColor,
    signalsCaptured,
    hasGemini: gem !== null,
    material,
    thicknessMm,
    budgetMin,
    budgetMax,
    timelineWeeks,
    application,
    product,
    recommendationReason,
    geminiSku: gem?.recommended_sku ?? null,
    concerns,
    lead: lead ?? null,
  })}

  <div class="ia-grid">
    ${renderTimeline({
      rec,
      lead: lead ?? null,
      recordingUrl: recordingUrl ?? null,
      transcript,
      agentSummary: summary,
      allCalls: allCalls ?? null,
    })}
    <div class="col-actions">
      ${renderActionsColumn(rec, lead ?? null)}
    </div>
  </div>

  <div class="footer">
    Generated by b2b-call-agent · M6 lead workspace · ${escapeHtml(rec.received_at)}
  </div>
</div>
</body>
</html>`;

  return html;
}

// ── M5 action panel renderer (CRM-style pipeline) ──────────────────────
// State-aware: shows different controls based on where the deal sits in the
// pipeline. Drafts visible during new_lead, become compact "✓ sent" cards
// after outreach. Stage transitions captured via dedicated forms.
// State pill metadata — shared between top-controls and any other caller that
// wants to badge a call's pipeline stage.
const STATE_META: Record<CallState, { label: string; color: string; bg: string }> = {
  new_lead:      { label: "🆕 New Lead",       color: "#075985", bg: "#e0f2fe" },
  outreach_sent: { label: "📤 Outreach Sent",  color: "#5b21b6", bg: "#ede9fe" },
  archived:      { label: "📦 Archived",        color: "#44403c", bg: "#e7e5e4" },
};

// Top controls strip — back link, state pill, post-action notice banner, and
// (for terminal stages) the final outcome banner. Replaces the M5 inline
// "state-bar / notice / outcome-final" mix that used to live in renderActionPanel.
function renderTopControls(
  rec: CallRecord,
  query?: URLSearchParams
): string {
  const actions = rec.actions ?? {};
  const state = normalizeState(rec.state);
  const sm = STATE_META[state];

  // URL-driven notice banner (post-redirect feedback from form POSTs).
  let notice = "";
  if (query) {
    const ok = query.get("ok");
    const err = query.get("err");
    const detail = query.get("detail");
    if (ok === "customer_sms") notice = `<div class="notice ok">✓ SMS sent to caller</div>`;
    else if (ok === "supplier_rfq") notice = `<div class="notice ok">✓ RFQ posted to #sourcing-china Slack</div>`;
    else if (ok === "briefing") notice = `<div class="notice ok">✓ Briefing marked as read</div>`;
    else if (ok === "archived") notice = `<div class="notice ok">📦 Lead archived. Continue in your own CRM.</div>`;
    else if (ok === "research_started") notice = `<div class="notice ok">🔍 Background check kicked off — Browser Use is researching now. This page will reflect results on refresh.</div>`;
    else if (ok === "research_pending") notice = `<div class="notice ok">🔍 A background check is already running for this caller. Refresh to see results.</div>`;
    else if (ok === "renamed") notice = `<div class="notice ok">✓ Customer name saved</div>`;
    else if (err) notice = `<div class="notice err">⚠️ Action failed: ${escapeHtml(err)}${detail ? " — " + escapeHtml(detail) : ""}</div>`;
  }

  // Final outcome banner (only when terminal stage).
  let outcomeBlock = "";
  if (actions.outcome === "won") {
    outcomeBlock = `<div class="outcome-final">🎉 <strong>Deal won</strong> · ${escapeHtml(actions.outcome_at ?? "")}${actions.outcome_note ? " · " + escapeHtml(actions.outcome_note) : ""}</div>`;
  } else if (actions.outcome === "lost") {
    outcomeBlock = `<div class="outcome-final lost">❌ <strong>Lost</strong> · ${escapeHtml(actions.outcome_at ?? "")}${actions.outcome_note ? " · " + escapeHtml(actions.outcome_note) : ""}</div>`;
  } else if (actions.outcome === "nurture") {
    outcomeBlock = `<div class="outcome-final" style="background:#ecfccb;border-color:#bef264;color:#365314;">🌱 <strong>Nurture</strong> · ${escapeHtml(actions.outcome_at ?? "")}${actions.outcome_note ? " · " + escapeHtml(actions.outcome_note) : ""}</div>`;
  }

  return `<div class="top-controls">
    <a href="/" class="back-link">← Back to cockpit</a>
    <span class="state-pill" style="background:${sm.bg};color:${sm.color};">${sm.label}</span>
    <span class="spacer"></span>
    <span class="meta">${escapeHtml(rec.call_id)}</span>
  </div>
  ${notice}
  ${outcomeBlock}`;
}

// Right-column actions panel — stageInfo + research + drafts + transition.
// Notice / state-bar / outcome / lead-banner are intentionally NOT in here;
// they live in renderTopControls (page header) and renderTimeline (history).
function renderActionsColumn(
  rec: CallRecord,
  lead: LeadIndex | null
): string {
  const drafts = rec.drafts;
  const actions = rec.actions ?? {};
  const state = normalizeState(rec.state);
  const callId = rec.call_id;

  const researchCard = renderResearchCard(lead, callId);

  // Legacy calls (no drafts): still expose research + transitions.
  if (!drafts) {
    const transitionBlock = renderStageTransition(state, callId, actions);
    return `<section class="action-panel">
      <h2>Actions</h2>
      ${researchCard}
      ${transitionBlock}
    </section>`;
  }

  const customerSmsCard = renderDraftCard(rec.call_id, "customer_sms", {
    title: "💬 Customer SMS",
    subtitle: "Sent via Agent Phone from +1 978 708 4114",
    draft: drafts.customer_sms,
    action: actions.customer_sms,
    sendPath: `/call/${encodeURIComponent(rec.call_id)}/send/customer_sms`,
    sendLabel: "Approve & Send SMS",
    inputType: "textarea",
  });
  const supplierRfqCard = renderDraftCard(rec.call_id, "supplier_rfq", {
    title: "🇨🇳 Supplier RFQ (Chinese)",
    subtitle: "Posted to #sourcing-china Slack",
    draft: drafts.supplier_rfq,
    action: actions.supplier_rfq,
    sendPath: `/call/${encodeURIComponent(rec.call_id)}/send/supplier_rfq`,
    sendLabel: "Approve & Send to China team",
    inputType: "textarea",
  });
  const briefingAcked = !!actions.briefing;
  const briefingCard = `<div class="action-card ${briefingAcked ? "done" : ""}">
    <div class="head">
      <span class="ttl">📋 Internal sales briefing</span>
      <span class="status">${briefingAcked ? `✓ Acked ${escapeHtml(actions.briefing!.acked_at)}` : "For sales rep — read before follow-up"}</span>
    </div>
    <div class="brief-md">${renderBriefingMarkdown(drafts.briefing)}</div>
    ${
      briefingAcked
        ? ""
        : `<form method="POST" action="/call/${encodeURIComponent(rec.call_id)}/ack/briefing">
            <div class="controls">
              <button type="submit" class="secondary">Mark as read</button>
            </div>
          </form>`
    }
  </div>`;

  const transitionBlock = renderStageTransition(state, callId, actions);

  return `<section class="action-panel">
    <h2>Actions</h2>
    ${researchCard}
    ${customerSmsCard}
    ${supplierRfqCard}
    ${briefingCard}
    ${transitionBlock}
  </section>`;
}

// ── M6 IA: Brief snapshot card ──────────────────────────────────────
// Top-of-page summary that consolidates "who is this and what do they want":
// caller identity, qualification, spec line, research summary, recommended
// SKU, and concerns. Replaces the old M2/M3 right-column qualification +
// recommended-product cards.

interface BriefArgs {
  displayName: string | null;             // sales-rep-set custom name
  callerName: string | null;              // Gemini-extracted personal name
  callerCompany: string | null;           // Gemini-extracted company name
  callerPhone: string;                    // raw phone for display
  leadPhoneForUrl: string | null;         // normalized phone for /person/:phone POST targets
  callCount: number;                      // number of calls from this lead
  startedAt: string;
  durationSeconds: number | null;
  disconnect: string | null;
  sentiment: string | null;
  callSuccessful: boolean | null;
  agentId: string | null;
  buyerPersona: string | null;
  score: number;
  tierLabel: string;
  tierColor: string;
  signalsCaptured: number;
  hasGemini: boolean;
  material: string | null;
  thicknessMm: number | null;
  budgetMin: number | null;
  budgetMax: number | null;
  timelineWeeks: number | null;
  application: string | null;
  product: CatalogProduct | null;
  recommendationReason: string | null;
  geminiSku: string | null;
  concerns: string[];
  lead: LeadIndex | null;
}

function renderBriefCard(a: BriefArgs): string {
  // Headline: prefer sales-rep-set display name; else Gemini-extracted
  // name+company; else "Unknown caller".
  const geminiBits: string[] = [];
  if (a.callerName) geminiBits.push(a.callerName);
  if (a.callerCompany) geminiBits.push(a.callerCompany);
  const geminiIdent = geminiBits.join(" · ");
  const headlineText = a.displayName ?? geminiIdent;
  const headline =
    headlineText && headlineText.length > 0
      ? escapeHtml(headlineText)
      : `<span style="color:var(--muted);font-style:italic;">Unknown caller</span>`;

  // Show the Gemini-extracted name as a secondary line ONLY if the rep set
  // a different display name — otherwise the headline already covers it.
  const secondaryIdent =
    a.displayName && geminiIdent.length > 0 && a.displayName !== geminiIdent
      ? `<div style="font-size:12px;color:var(--muted);margin-top:2px;">from call: ${escapeHtml(geminiIdent)}</div>`
      : "";

  const durationStr = a.durationSeconds !== null ? `${a.durationSeconds.toFixed(1)}s` : "—";

  // Inline rename form. Collapsible <details> so it doesn't crowd the brief
  // when not in use. Posts to /person/:phone/rename. If we don't have a
  // normalized phone (synthetic test data), suppress the form.
  const renameForm = a.leadPhoneForUrl
    ? `<details class="rename-form">
        <summary>${a.displayName ? "✏️ Rename" : "✏️ Name this customer"}</summary>
        <form method="POST" action="/person/${encodeURIComponent(a.leadPhoneForUrl)}/rename">
          <input type="text" name="display_name" placeholder="e.g. Ron @ Hudson Sign Co" value="${a.displayName ? escapeHtml(a.displayName) : ""}" autocomplete="off" />
          <button type="submit" class="primary">Save</button>
          ${a.displayName ? `<button type="submit" name="display_name" value="" class="secondary" formnovalidate>Clear</button>` : ""}
        </form>
      </details>`
    : "";

  // Small meta badges restored from the old M2 header.
  const metaBadges: string[] = [];
  if (a.sentiment) {
    const cls = a.sentiment.toLowerCase() === "positive" ? "pos" : a.sentiment.toLowerCase() === "negative" ? "neg" : "";
    metaBadges.push(`<span class="badge ${cls}">${escapeHtml(a.sentiment)}</span>`);
  }
  if (a.callSuccessful === true) metaBadges.push(`<span class="badge pos">Call successful</span>`);
  else if (a.callSuccessful === false) metaBadges.push(`<span class="badge neg">Call unsuccessful</span>`);
  if (a.disconnect && a.disconnect !== "—") metaBadges.push(`<span class="badge">disconnect: ${escapeHtml(a.disconnect)}</span>`);
  if (a.agentId) metaBadges.push(`<span class="badge" style="font-family:ui-monospace,monospace;font-size:10px;">${escapeHtml(a.agentId)}</span>`);
  const metaRow = metaBadges.length
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">${metaBadges.join("")}</div>`
    : "";

  const callCountLabel = a.callCount > 1 ? ` · ${a.callCount} calls` : "";

  // Spec row (Material × Thickness × Budget × Timeline)
  const budgetStr =
    a.budgetMin !== null
      ? a.budgetMin === a.budgetMax
        ? `$${a.budgetMin.toLocaleString()}`
        : `$${a.budgetMin.toLocaleString()}–$${(a.budgetMax ?? a.budgetMin).toLocaleString()}`
      : null;
  const specRow = `<div class="brief-row">
    <div class="lbl-row">
      <div class="cell"><div class="lbl">Material</div><div class="val ${a.material ? "" : "miss"}">${escapeHtml(a.material ?? "not detected")}</div></div>
      <div class="cell"><div class="lbl">Thickness</div><div class="val ${a.thicknessMm !== null ? "" : "miss"}">${a.thicknessMm !== null ? `${a.thicknessMm} mm` : "not detected"}</div></div>
      <div class="cell"><div class="lbl">Budget</div><div class="val ${budgetStr ? "" : "miss"}">${budgetStr ?? "not detected"}</div></div>
      <div class="cell"><div class="lbl">Timeline</div><div class="val ${a.timelineWeeks !== null ? "" : "miss"}">${a.timelineWeeks !== null ? `${a.timelineWeeks} weeks` : "not detected"}</div></div>
    </div>
  </div>`;

  // Research summary row (only when done with useful fields).
  let researchRow = "";
  const r = a.lead?.research;
  if (r && r.status === "done") {
    const bits: string[] = [];
    if (r.company_name) bits.push(`<strong>${escapeHtml(r.company_name)}</strong>`);
    if (r.industry) bits.push(escapeHtml(r.industry));
    if (r.size) bits.push(escapeHtml(r.size));
    if (r.website) bits.push(`<a href="${escapeHtml(r.website)}" target="_blank" rel="noopener">${escapeHtml(r.website)}</a>`);
    const summary = [r.recent_news, r.buying_signals].filter(Boolean).map((s) => escapeHtml(s!)).join(" — ");
    if (bits.length || summary) {
      researchRow = `<div class="brief-row research">
        <div class="lbl">🔍 Caller research</div>
        <div class="body">${bits.join(" · ")}${summary ? `<br>${summary}` : ""}</div>
      </div>`;
    }
  } else if (r && r.status === "pending") {
    researchRow = `<div class="brief-row research">
      <div class="lbl">🔍 Caller research</div>
      <div class="body" style="color:#92400e;font-style:italic;">⏳ Researching… see the Actions column for status.</div>
    </div>`;
  }

  // Recommended SKU row.
  let skuRow = "";
  if (a.product) {
    const p = a.product;
    const specs = `${p.power_w}W · ${p.working_area_mm[0]}×${p.working_area_mm[1]}mm · max ${p.max_steel_thickness_mm}mm steel · ${p.lead_time_weeks}wk lead · $${p.price_usd_range[0].toLocaleString()}–$${p.price_usd_range[1].toLocaleString()}`;
    skuRow = `<div class="brief-row sku">
      <div class="sku-key">→ ${escapeHtml(p.sku)}</div>
      <div class="name">${escapeHtml(p.name)}${p.product_url ? ` · <a href="${escapeHtml(p.product_url)}" target="_blank" rel="noopener">ferrolaser.com →</a>` : ""}</div>
      <div class="specs">${escapeHtml(specs)}</div>
      ${a.recommendationReason ? `<div class="reason">"${escapeHtml(a.recommendationReason)}"</div>` : ""}
    </div>`;
  } else if (a.geminiSku) {
    skuRow = `<div class="brief-row sku">
      <div class="sku-key">→ ${escapeHtml(a.geminiSku)}</div>
      <div class="name" style="color:var(--muted);font-style:italic;">Gemini suggested this SKU but it's not in the local catalog.</div>
      ${a.recommendationReason ? `<div class="reason">"${escapeHtml(a.recommendationReason)}"</div>` : ""}
    </div>`;
  }

  // Concerns row.
  let concernsRow = "";
  if (a.concerns.length) {
    concernsRow = `<div class="brief-row concerns">
      <div class="lbl">⚠️ Concerns</div>
      <ul>${a.concerns.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>
    </div>`;
  }

  return `<section class="brief-card">
    <div class="brief-ident">
      <h1>${headline}</h1>
      ${secondaryIdent}
      <div class="ident-meta">${escapeHtml(a.callerPhone)}${callCountLabel} · latest call ${escapeHtml(a.startedAt)} · ${durationStr}</div>
      ${a.buyerPersona ? `<div class="persona-line">${escapeHtml(a.buyerPersona)}${a.application ? ` · ${escapeHtml(a.application)}` : ""}</div>` : (a.application ? `<div class="persona-line">${escapeHtml(a.application)}</div>` : "")}
      ${metaRow}
      ${renameForm}
    </div>
    <div class="brief-tier">
      <span class="pill" style="background:${a.tierColor};">${escapeHtml(a.tierLabel)} ${a.score}</span>
      <span class="signal-note">${a.signalsCaptured} of 4 signals${a.hasGemini ? " · Gemini" : ""}</span>
    </div>
    ${specRow}
    ${researchRow}
    ${skuRow}
    ${concernsRow}
  </section>`;
}

// ── M6 IA: History timeline ─────────────────────────────────────────
// Builds a chronological feed of every touchpoint with this lead — the
// current call (with audio + transcript inline), prior calls (compact link
// rows), outbound SMS/RFQ, briefing acks, research events, stage transitions,
// and the final outcome. Newest first.

interface TimelineArgs {
  rec: CallRecord;
  lead: LeadIndex | null;
  recordingUrl: string | null;
  transcript: TranscriptEntry[];
  agentSummary: string | null;
  // When provided (from /person/:phone), every call's transcript renders
  // inline as a collapsed <details>. When omitted (legacy /call/:id), only
  // the current call's transcript is shown and other calls are link rows.
  allCalls?: CallRecord[] | null;
}

interface TimelineEntry {
  ts: string;       // ISO timestamp for sort
  icon: string;
  title: string;
  body: string;     // HTML
  isCurrent?: boolean;
  compact?: boolean;
}

function renderTimeline(a: TimelineArgs): string {
  const rec = a.rec;
  const actions = rec.actions ?? {};
  const entries: TimelineEntry[] = [];

  // Current call — always present. Audio + transcript inline. Stickied as
  // "isCurrent" so the border highlights even when later actions push it down.
  const currentBody = (() => {
    const bits: string[] = [];
    if (a.recordingUrl) {
      bits.push(`<audio controls preload="none" src="${escapeHtml(a.recordingUrl)}"></audio>`);
    } else {
      bits.push(`<div style="font-size:12px;color:var(--muted);font-style:italic;margin-bottom:6px;">🎧 No recording for this call (Agent Phone recording add-on disabled at the time).</div>`);
    }
    if (a.transcript.length === 0) {
      bits.push(`<div style="color:var(--muted);font-style:italic;">No transcript captured.</div>`);
    } else {
      bits.push(
        `<div style="margin-top:8px;">` +
          a.transcript
            .map(
              (m) => `<div class="bubble ${m.role === "user" ? "user" : "agent"}">
                <div class="who">${escapeHtml(m.role)}</div>
                <div>${escapeHtml(m.content)}</div>
              </div>`
            )
            .join("") +
        `</div>`
      );
    }
    if (a.agentSummary) {
      bits.push(`<div class="preview" style="margin-top:10px;"><strong>Agent Phone summary:</strong> ${escapeHtml(a.agentSummary)}</div>`);
    }
    return bits.join("");
  })();
  entries.push({
    ts: rec.received_at,
    icon: "📞",
    title: "Inbound call · this one",
    body: currentBody,
    isCurrent: true,
  });

  // Other calls from this lead — render their transcripts inline (collapsed)
  // when we have the full records, else fall back to compact link rows.
  if (a.allCalls && a.allCalls.length > 0) {
    for (const other of a.allCalls) {
      if (other.call_id === rec.call_id) continue;
      const oData = (other.payload?.data ?? other.payload ?? {}) as Record<string, unknown>;
      const oTranscript: TranscriptEntry[] = (() => {
        const t = oData.transcript;
        if (Array.isArray(t)) {
          return (t as Array<Record<string, unknown>>)
            .map((m) => ({ role: String(m.role ?? "?"), content: String(m.content ?? "") }))
            .filter((m) => m.content.length > 0);
        }
        return [];
      })();
      const oDuration = typeof oData.durationSeconds === "number" ? (oData.durationSeconds as number) : null;
      const oRecording =
        other.recording_url ??
        (typeof oData.recordingUrl === "string" ? oData.recordingUrl : null);
      const transcriptHtml =
        oTranscript.length === 0
          ? `<div style="color:var(--muted);font-style:italic;font-size:12px;">No transcript captured.</div>`
          : oTranscript
              .map(
                (m) => `<div class="bubble ${m.role === "user" ? "user" : "agent"}">
                <div class="who">${escapeHtml(m.role)}</div>
                <div>${escapeHtml(m.content)}</div>
              </div>`
              )
              .join("");
      const audioHtml = oRecording
        ? `<audio controls preload="none" src="${escapeHtml(oRecording)}"></audio>`
        : `<div style="font-size:11px;color:var(--muted);font-style:italic;margin-bottom:6px;">🎧 No recording.</div>`;
      const durStr = oDuration !== null ? `${oDuration.toFixed(1)}s` : "—";
      entries.push({
        ts: other.received_at,
        icon: "📞",
        title: `Earlier call · ${durStr}`,
        body: `<details>
          <summary style="cursor:pointer;color:var(--accent);font-size:12px;">View transcript${oRecording ? " + recording" : ""}</summary>
          <div style="margin-top:8px;">${audioHtml}${transcriptHtml}</div>
        </details>`,
      });
    }
  } else if (a.lead) {
    for (const c of a.lead.calls) {
      if (c.call_id === rec.call_id) continue;
      entries.push({
        ts: c.received_at,
        icon: "📞",
        title: `Earlier call`,
        body: `<a class="entry-link" href="/call/${escapeHtml(encodeURIComponent(c.call_id))}">→ View ${escapeHtml(c.call_id)}</a>`,
        compact: true,
      });
    }
  }

  // Sent customer SMS
  if (actions.customer_sms) {
    const cs = actions.customer_sms;
    entries.push({
      ts: cs.sent_at,
      icon: "💬",
      title: "Customer SMS sent",
      body: `<div class="preview">${escapeHtml(cs.sent_text)}</div>${cs.message_id ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;">msg_id ${escapeHtml(cs.message_id)}</div>` : ""}`,
    });
  }

  // Sent supplier RFQ
  if (actions.supplier_rfq) {
    const sr = actions.supplier_rfq;
    entries.push({
      ts: sr.sent_at,
      icon: "🇨🇳",
      title: "Supplier RFQ sent · #sourcing-china",
      body: `<div class="preview">${escapeHtml(sr.sent_text)}</div>`,
    });
  }

  // Briefing acked
  if (actions.briefing) {
    entries.push({
      ts: actions.briefing.acked_at,
      icon: "📋",
      title: "Internal briefing acked",
      body: `<div style="color:var(--muted);font-size:12px;">Sales rep marked the AI briefing as read.</div>`,
      compact: true,
    });
  }

  // Factory quote confirmed
  if (actions.quote) {
    const q = actions.quote;
    const priceStr = q.factory_price_usd ? `$${q.factory_price_usd.toLocaleString()}` : "—";
    const ltStr = q.factory_lead_time_weeks ? `${q.factory_lead_time_weeks}wk` : "—";
    entries.push({
      ts: q.factory_confirmed_at,
      icon: "🏭",
      title: "Factory quote confirmed",
      body: `<div>${priceStr} · ${ltStr} lead time</div>${q.notes ? `<div class="preview">${escapeHtml(q.notes)}</div>` : ""}`,
    });
  }

  // Customer response
  if (actions.customer_response) {
    const cr = actions.customer_response;
    entries.push({
      ts: cr.received_at,
      icon: "💬",
      title: `Customer response · ${cr.sentiment ?? "engaged"}`,
      body: cr.notes ? `<div class="preview">${escapeHtml(cr.notes)}</div>` : `<div style="color:var(--muted);font-size:12px;">No notes captured.</div>`,
    });
  }

  // v0.2 archive event
  if (actions.archived_at) {
    entries.push({
      ts: actions.archived_at,
      icon: "📦",
      title: "Archived · handed off to customer CRM",
      body: actions.archived_note
        ? `<div class="preview">${escapeHtml(actions.archived_note)}</div>`
        : `<div style="color:var(--muted);font-size:12px;">No note. The deal continues outside this system.</div>`,
    });
  }

  // Legacy v0.1 outcome event — only renders for old KV records still in
  // the lead's history. v0.2 doesn't write these.
  if (actions.outcome && actions.outcome_at) {
    const outcome = actions.outcome;
    const icon = outcome === "won" ? "🎉" : outcome === "lost" ? "❌" : "🌱";
    const label = outcome === "won" ? "Closed Won (legacy)" : outcome === "lost" ? "Closed Lost (legacy)" : "Nurture (legacy)";
    entries.push({
      ts: actions.outcome_at,
      icon,
      title: label,
      body: actions.outcome_note
        ? `<div class="preview">${escapeHtml(actions.outcome_note)}</div>`
        : `<div style="color:var(--muted);font-size:12px;">No note.</div>`,
    });
  }

  // Research events (started / finished)
  const r = a.lead?.research;
  if (r) {
    entries.push({
      ts: r.started_at,
      icon: "🔍",
      title: "Background check started · Browser Use",
      body: r.live_url
        ? `<a class="entry-link" href="${escapeHtml(r.live_url)}" target="_blank" rel="noopener">📺 Watch live</a>`
        : `<div style="color:var(--muted);font-size:12px;">Searching…</div>`,
      compact: true,
    });
    if (r.finished_at && (r.status === "done" || r.status === "failed")) {
      const okFail = r.status === "done" ? "completed" : "failed";
      const summary = r.status === "done"
        ? [r.company_name, r.industry].filter(Boolean).join(" · ") || "Returned (no specific company identified)"
        : r.error ?? "Unknown error";
      entries.push({
        ts: r.finished_at,
        icon: "🔍",
        title: `Background check ${okFail}`,
        body: `<div>${escapeHtml(summary)}</div>`,
        compact: true,
      });
    }
  }

  // Sort by timestamp desc. Current call retains its real timestamp; if there
  // are no other entries it ends up first naturally.
  entries.sort((x, y) => (y.ts ?? "").localeCompare(x.ts ?? ""));

  const cards = entries
    .map((e) => {
      const cls = ["timeline-entry"];
      if (e.isCurrent) cls.push("current");
      if (e.compact) cls.push("compact");
      const when = formatRelativeFromIso(e.ts);
      return `<div class="${cls.join(" ")}">
        <div class="row">
          <span class="ttl">${e.icon} ${escapeHtml(e.title)}</span>
          <span class="when">${when} ago</span>
        </div>
        <div class="body">${e.body}</div>
      </div>`;
    })
    .join("");

  const phoneLabel = a.lead?.phone ? escapeHtml(a.lead.phone) : "";
  const headerNote = a.lead && a.lead.calls.length > 1
    ? `<div style="font-size:12px;color:var(--muted);margin-bottom:8px;">🗂 ${a.lead.calls.length} calls from ${phoneLabel} · this one is the most recent below.</div>`
    : "";

  return `<section class="col-timeline">
    <h2>History</h2>
    ${headerNote}
    <div class="timeline">${cards}</div>
  </section>`;
}

// Browser Use caller-research card — shows one of 4 states:
//   - no research yet → kickoff button
//   - pending        → progress hint + Refresh link + live URL
//   - done (success) → structured company brief
//   - failed         → error + retry
function renderResearchCard(lead: LeadIndex | null, callId: string): string {
  const r = lead?.research ?? null;
  const postPath = `/call/${encodeURIComponent(callId)}/research-caller`;

  if (!r) {
    return `<div class="research-card">
      <div class="head">
        <span class="ttl">🔍 Caller research</span>
        <span class="status">Browser Use cloud · ~30s-2min · ~$0.30/check</span>
      </div>
      <div class="pitch">Have an AI agent look up this caller's company online — size, industry, recent news, and any buying signals.</div>
      <form method="POST" action="${postPath}">
        <button type="submit" class="primary">🌐 Run background check</button>
      </form>
    </div>`;
  }

  if (r.status === "pending") {
    const progress = r.last_step_summary
      ? `<div class="progress">⏳ ${escapeHtml(r.last_step_summary)}</div>`
      : `<div class="progress">⏳ Agent is researching… give it 30s-2min then refresh.</div>`;
    const live = r.live_url
      ? `<a href="${escapeHtml(r.live_url)}" target="_blank" rel="noopener">📺 Watch live</a>`
      : "";
    return `<div class="research-card pending">
      <div class="head">
        <span class="ttl">🔍 Caller research</span>
        <span class="status">pending · started ${escapeHtml(formatRelativeFromIso(r.started_at))} ago</span>
      </div>
      ${progress}
      <div class="pending-row">
        <a href="/call/${escapeHtml(encodeURIComponent(callId))}">↻ Refresh</a>
        ${live}
      </div>
    </div>`;
  }

  if (r.status === "failed") {
    return `<div class="research-card failed">
      <div class="head">
        <span class="ttl">🔍 Caller research</span>
        <span class="status">failed${r.finished_at ? ` · ${escapeHtml(formatRelativeFromIso(r.finished_at))} ago` : ""}</span>
      </div>
      <div class="pitch">${escapeHtml(r.error ?? "Browser Use session ended without a usable result.")}</div>
      <form method="POST" action="${postPath}">
        <button type="submit" class="primary">↻ Retry background check</button>
      </form>
    </div>`;
  }

  // done — render structured fields
  const rows: string[] = [];
  if (r.company_name) rows.push(`<dt>Company</dt><dd>${escapeHtml(r.company_name)}</dd>`);
  if (r.industry)     rows.push(`<dt>Industry</dt><dd>${escapeHtml(r.industry)}</dd>`);
  if (r.size)         rows.push(`<dt>Size</dt><dd>${escapeHtml(r.size)}</dd>`);
  if (r.website)      rows.push(`<dt>Website</dt><dd><a href="${escapeHtml(r.website)}" target="_blank" rel="noopener">${escapeHtml(r.website)}</a></dd>`);
  if (r.recent_news)  rows.push(`<dt>Recent</dt><dd>${escapeHtml(r.recent_news)}</dd>`);
  if (r.buying_signals) rows.push(`<dt>Signals</dt><dd>${escapeHtml(r.buying_signals)}</dd>`);
  if (r.notes)        rows.push(`<dt>Notes</dt><dd>${escapeHtml(r.notes)}</dd>`);
  const body = rows.length
    ? `<dl class="grid">${rows.join("")}</dl>`
    : `<div class="pitch">No company details found. The agent searched but couldn't identify the business behind this number.</div>`;
  return `<div class="research-card done">
    <div class="head">
      <span class="ttl">🔍 Caller research</span>
      <span class="status">done${r.finished_at ? ` · ${escapeHtml(formatRelativeFromIso(r.finished_at))} ago` : ""}</span>
    </div>
    ${body}
    <div class="pending-row">
      <form method="POST" action="${postPath}"><button type="submit" class="secondary">↻ Re-run</button></form>
    </div>
  </div>`;
}

// Cheap "Xs / Xm / Xh / Xd ago" formatter. Matches dashboard's flavor but
// duplicated here to avoid a cross-file import for one helper.
function formatRelativeFromIso(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const t = new Date(iso).getTime();
    const now = Date.now();
    const sec = Math.floor((now - t) / 1000);
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
    return `${Math.floor(sec / 86400)}d`;
  } catch {
    return iso;
  }
}

function renderStageTransition(state: CallState, callId: string, actions: CallActions): string {
  // Archived (terminal): nothing to do here. The lead lives in the customer's
  // own CRM from this point on.
  if (state === "archived") {
    const when = actions.archived_at ? formatRelativeFromIso(actions.archived_at) : "—";
    return `<div class="transition-bar" style="background:#fafaf9;border-color:#e7e5e4;">
      <span style="font-size:13px;color:var(--muted);">📦 Archived ${escapeHtml(when)} ago${actions.archived_note ? ` — <em>${escapeHtml(actions.archived_note)}</em>` : ""}. Continue in your own CRM.</span>
    </div>`;
  }

  // new_lead: show outreach progress + an early archive button (for bad fits).
  if (state === "new_lead") {
    const sent = [actions.customer_sms, actions.supplier_rfq, actions.briefing].filter(Boolean).length;
    return `<div class="transition-bar">
      <span class="label">Next step:</span>
      <span style="color:var(--muted);font-size:13px;">${sent}/3 outreach actions complete. Send all three to auto-advance to <strong>Outreach Sent</strong>.</span>
      <form method="POST" action="/call/${encodeURIComponent(callId)}/archive" style="margin-top:10px;width:100%;">
        <input type="text" name="note" placeholder="Reason (optional) — e.g. bad fit, spam, duplicate" style="width:60%;margin-right:6px;">
        <button type="submit" class="secondary">📦 Archive (skip outreach)</button>
      </form>
    </div>`;
  }

  // outreach_sent: hand off — the deal continues in the customer's own CRM.
  return `<form method="POST" action="/call/${encodeURIComponent(callId)}/archive">
    <div class="transition-bar">
      <div style="width:100%;">
        <div class="label" style="margin-bottom:10px;">📦 Done with the AI portion? Hand off to your own CRM (HubSpot / Salesforce / Feishu OA / Airtable):</div>
        <div class="transition-row">
          <input type="text" name="note" placeholder="Where it's going (optional) — e.g. HubSpot deal #1234">
          <button type="submit" class="primary">📦 Hand off to my CRM</button>
        </div>
      </div>
    </div>
  </form>`;
}

interface DraftCardOptions {
  title: string;
  subtitle: string;
  draft: string;
  action?: { sent_at: string; sent_text: string; message_id?: string };
  sendPath: string;
  sendLabel: string;
  inputType: "textarea";
}

function renderDraftCard(
  _callId: string,
  _fieldName: string,
  opts: DraftCardOptions
): string {
  const done = !!opts.action;
  if (done) {
    return `<div class="action-card done">
      <div class="head">
        <span class="ttl">${opts.title}</span>
        <span class="status">✓ Sent ${escapeHtml(opts.action!.sent_at)}${opts.action!.message_id ? ` · msg_id ${escapeHtml(opts.action!.message_id)}` : ""}</span>
      </div>
      <div class="sent-info">${escapeHtml(opts.action!.sent_text)}</div>
    </div>`;
  }
  return `<div class="action-card">
    <div class="head">
      <span class="ttl">${opts.title}</span>
      <span class="status">${escapeHtml(opts.subtitle)}</span>
    </div>
    <form method="POST" action="${opts.sendPath}">
      <textarea name="text">${escapeHtml(opts.draft)}</textarea>
      <div class="controls">
        <button type="submit">${escapeHtml(opts.sendLabel)}</button>
      </div>
    </form>
  </div>`;
}

// Tiny markdown→HTML for briefing display (only handles **bold**, line breaks,
// and bullet items "• ..." or "- ..."). No external lib.
function renderBriefingMarkdown(md: string): string {
  const esc = escapeHtml(md);
  // Bold
  let html = esc.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Bullet list lines
  html = html.replace(/(^|\n)(?:[•\-] )(.+)/g, "$1<span style=\"display:block;padding-left:16px;text-indent:-12px;\">• $2</span>");
  return html;
}
