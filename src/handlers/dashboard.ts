import type { Bindings } from "../types";
import { normalizeState, type CallRecord, type CallState } from "../lib/render";
import type { LeadIndex } from "../lib/leads";
import { normalizePhone } from "../lib/leads";

// GET / — sales cockpit dashboard, CRM-style pipeline.
// 5 active stages + 2 collapsed terminal columns.
// Click a card to open the action panel on /call/:id.

// Dashboard card summary — one per LEAD (deduped by phone). All per-call
// state (state, qualification, drafts sent) is drawn from the lead's most
// recent call.
interface CallSummary {
  call_id: string;
  caller_phone: string | null;
  buyer_persona: string | null;
  buyer_application: string | null;
  caller_name: string | null;
  caller_company: string | null;
  // M6: lead-level fields used by the new card.
  display_name: string | null;            // sales-rep-set name
  lead_phone_normalized: string | null;   // for /person/:phone URL
  call_count: number;                     // total calls from this lead
  received_at: string;
  state: CallState;
  stage_entered_at: string | null;
  score: number;
  tier: string;
  recommended_sku: string | null;
  budget_min: number | null;
  budget_max: number | null;
  thickness_mm: number | null;
  material: string | null;
  duration_seconds: number | null;
  // Sub-indicators
  customer_sms_sent: boolean;
  supplier_rfq_sent: boolean;
  briefing_acked: boolean;
  factory_price: number | null;
  factory_lead_time: number | null;
  customer_sentiment: string | null;
  // Lead-scoped enrichment (from Browser Use background check).
  research_company: string | null;
  research_industry: string | null;
  research_size: string | null;
  research_status: "pending" | "done" | "failed" | null;
}

function summarize(
  rec: CallRecord,
  lead: LeadIndex | null
): CallSummary {
  const d = (rec.payload?.data ?? rec.payload ?? {}) as Record<string, unknown>;
  const ent = rec.entities ?? null;
  const a = rec.actions ?? {};
  const research = lead?.research ?? null;
  return {
    call_id: rec.call_id,
    caller_phone:
      typeof d.from === "string"
        ? d.from
        : typeof d.caller_phone === "string"
        ? (d.caller_phone as string)
        : null,
    buyer_persona: ent?.buyer_persona ?? null,
    buyer_application: ent?.application ?? null,
    caller_name: ent?.caller_name ?? null,
    caller_company: ent?.caller_company ?? null,
    display_name: lead?.display_name ?? null,
    lead_phone_normalized: lead?.phone ?? null,
    call_count: lead?.calls.length ?? 1,
    received_at: rec.received_at,
    state: normalizeState(rec.state),
    stage_entered_at: a.stage_entered_at ?? rec.received_at,
    score: ent?.qual_score ?? 0,
    tier: ent?.qual_tier ?? "cold",
    recommended_sku: ent?.recommended_sku ?? null,
    budget_min: ent?.budget_usd_min ?? null,
    budget_max: ent?.budget_usd_max ?? null,
    thickness_mm: ent?.thickness_mm ?? null,
    material: ent?.material ?? null,
    duration_seconds:
      typeof d.durationSeconds === "number" ? (d.durationSeconds as number) : null,
    customer_sms_sent: !!a.customer_sms,
    supplier_rfq_sent: !!a.supplier_rfq,
    briefing_acked: !!a.briefing,
    factory_price: a.quote?.factory_price_usd ?? null,
    factory_lead_time: a.quote?.factory_lead_time_weeks ?? null,
    customer_sentiment: a.customer_response?.sentiment ?? null,
    research_company: research?.company_name ?? null,
    research_industry: research?.industry ?? null,
    research_size: research?.size ?? null,
    research_status: research?.status ?? null,
  };
}

export async function handleDashboard(env: Bindings): Promise<Response> {
  // Build phone → LeadIndex map; we use it to dedupe calls by phone and to
  // surface lead.display_name / lead.research / lead.calls.length on each
  // card. Calls without a resolvable phone (synthetic test data) get a card
  // each, keyed by call_id.
  const leadsByPhone = new Map<string, LeadIndex>();
  const allCalls: CallRecord[] = [];
  try {
    const listing = await env.CALLS.list({ limit: 200 });
    const leadKeys: string[] = [];
    const callKeys: string[] = [];
    for (const k of listing.keys) {
      if (k.name.startsWith("lead:")) leadKeys.push(k.name);
      else callKeys.push(k.name);
    }
    for (const lk of leadKeys) {
      const raw = await env.CALLS.get(lk);
      if (!raw) continue;
      try {
        const lead = JSON.parse(raw) as LeadIndex;
        if (lead?.phone) leadsByPhone.set(lead.phone, lead);
      } catch {
        /* skip malformed */
      }
    }
    for (const k of callKeys) {
      const raw = await env.CALLS.get(k);
      if (!raw) continue;
      try {
        const rec = JSON.parse(raw) as CallRecord;
        if (!rec.call_id) continue;
        allCalls.push(rec);
      } catch {
        /* skip malformed */
      }
    }
  } catch (err) {
    console.warn("[dashboard] kv list failed:", err);
  }

  // Group calls by normalized phone (or by call_id if phone is unresolvable).
  // For each group, pick the newest call as the representative.
  const groups = new Map<string, CallRecord>();
  for (const rec of allCalls) {
    const d = (rec.payload?.data ?? rec.payload ?? {}) as Record<string, unknown>;
    const phoneRaw =
      (typeof d.from === "string" ? d.from : null) ??
      (typeof d.caller_phone === "string" ? (d.caller_phone as string) : null);
    const groupKey = normalizePhone(phoneRaw) ?? `call:${rec.call_id}`;
    const existing = groups.get(groupKey);
    if (!existing || (rec.received_at ?? "") > (existing.received_at ?? "")) {
      groups.set(groupKey, rec);
    }
  }

  const calls: CallSummary[] = [];
  for (const [groupKey, primary] of groups.entries()) {
    const lead = groupKey.startsWith("call:") ? null : leadsByPhone.get(groupKey) ?? null;
    calls.push(summarize(primary, lead));
  }

  calls.sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""));

  const html = renderDashboard(calls);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;";
  });
}

function tierColor(score: number): string {
  if (score >= 75) return "#16a34a";
  if (score >= 50) return "#ca8a04";
  if (score >= 25) return "#ea580c";
  return "#dc2626";
}

function tierLabel(score: number, fromGemini: string | null): string {
  if (fromGemini && /^(hot|warm|cool|cold)$/i.test(fromGemini)) {
    return fromGemini.charAt(0).toUpperCase() + fromGemini.slice(1).toLowerCase();
  }
  if (score >= 75) return "Hot";
  if (score >= 50) return "Warm";
  if (score >= 25) return "Cool";
  return "Cold";
}

function formatRelative(iso: string | null): string {
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

function formatBudget(min: number | null, max: number | null): string | null {
  if (min === null && max === null) return null;
  if (min === max && min !== null) return `$${min.toLocaleString()}`;
  if (min !== null && max !== null) return `$${(min / 1000).toFixed(0)}k–$${(max / 1000).toFixed(0)}k`;
  const v = min ?? max ?? 0;
  return `$${v.toLocaleString()}`;
}

function renderCard(c: CallSummary): string {
  const tierBg = tierColor(c.score);
  const tier = tierLabel(c.score, c.tier);
  const phone = c.caller_phone ?? "unknown";
  const budget = formatBudget(c.budget_min, c.budget_max);
  const inStage = formatRelative(c.stage_entered_at);

  // Build the spec line (material × thickness × budget)
  const specBits: string[] = [];
  if (c.material) specBits.push(c.material);
  if (c.thickness_mm !== null) specBits.push(`${c.thickness_mm}mm`);
  if (budget) specBits.push(budget);
  const specLine = specBits.join(" · ");

  // AI prep chips
  const aiPrep = [
    { label: "SMS", done: c.customer_sms_sent },
    { label: "RFQ", done: c.supplier_rfq_sent },
    { label: "Brief", done: c.briefing_acked },
  ];
  const aiPrepHtml = aiPrep
    .map(
      (x) =>
        `<span class="chip ${x.done ? "done" : ""}">${x.done ? "✓" : "○"} ${x.label}</span>`
    )
    .join("");

  // Sub-indicators specific to later stages
  let stageDetail = "";
  if (c.state === "quoted" && c.factory_price !== null) {
    const lt = c.factory_lead_time !== null ? ` · ${c.factory_lead_time}wk` : "";
    stageDetail = `<div class="stage-detail">🏭 Factory: $${c.factory_price.toLocaleString()}${lt}</div>`;
  } else if (c.state === "negotiating" && c.customer_sentiment) {
    const emoji = c.customer_sentiment === "positive" ? "👍" : c.customer_sentiment === "objecting" ? "⚠️" : "💬";
    stageDetail = `<div class="stage-detail">${emoji} Customer: ${escapeHtml(c.customer_sentiment)}</div>`;
  }

  // Caller identity line — prefer sales-rep-set display_name, else fall
  // back to the Gemini-extracted caller_name / caller_company.
  const geminiBits: string[] = [];
  if (c.caller_name) geminiBits.push(c.caller_name);
  if (c.caller_company) geminiBits.push(c.caller_company);
  const identLabel = c.display_name ?? (geminiBits.length ? geminiBits.join(" · ") : null);
  const idLine = identLabel ? `<div class="ident">${escapeHtml(identLabel)}</div>` : "";

  // Research enrichment line — only when BU returned something useful.
  let researchLine = "";
  if (c.research_status === "done") {
    const rBits: string[] = [];
    if (c.research_industry) rBits.push(c.research_industry);
    if (c.research_size) rBits.push(c.research_size);
    if (c.research_company && !geminiBits.includes(c.research_company)) rBits.unshift(c.research_company);
    if (rBits.length) {
      researchLine = `<div class="research-line">🔍 ${escapeHtml(rBits.join(" · "))}</div>`;
    }
  } else if (c.research_status === "pending") {
    researchLine = `<div class="research-line pending">🔍 researching…</div>`;
  }

  // Card URL — prefer /person/<phone> (canonical), fall back to /call/<id>
  // for synthetic test data without a normalized phone.
  const href = c.lead_phone_normalized
    ? `/person/${encodeURIComponent(c.lead_phone_normalized)}`
    : `/call/${encodeURIComponent(c.call_id)}`;

  // Call-count badge — only when the lead has more than one call.
  const callCountBadge = c.call_count > 1
    ? `<span class="call-count">📞 ${c.call_count}</span>`
    : "";

  return `<a class="card-call" href="${escapeHtml(href)}">
    <div class="row1">
      <div class="phone">${escapeHtml(phone)}${callCountBadge}</div>
      <span class="tier-pill" style="background:${tierBg};">${escapeHtml(tier)} ${c.score}</span>
    </div>
    ${idLine}
    ${c.buyer_persona ? `<div class="persona">${escapeHtml(c.buyer_persona)}</div>` : ""}
    ${specLine ? `<div class="spec">${escapeHtml(specLine)}</div>` : ""}
    ${researchLine}
    ${c.recommended_sku ? `<div class="sku">→ ${escapeHtml(c.recommended_sku)}</div>` : ""}
    ${stageDetail}
    <div class="chips-row">${aiPrepHtml}</div>
    <div class="meta">
      <span>⏱ ${inStage} in stage</span>
    </div>
  </a>`;
}

const COLUMN_LABELS: Record<CallState, { label: string; emoji: string; color: string; collapsed?: boolean }> = {
  new_lead:      { label: "New Lead",      emoji: "🆕", color: "#0ea5e9" },
  outreach_sent: { label: "Outreach Sent", emoji: "📤", color: "#8b5cf6" },
  quoted:        { label: "Quoted",        emoji: "📄", color: "#f59e0b" },
  negotiating:   { label: "Negotiating",   emoji: "💬", color: "#ec4899" },
  closed_won:    { label: "Closed Won",    emoji: "🎉", color: "#16a34a", collapsed: true },
  closed_lost:   { label: "Closed Lost",   emoji: "❌", color: "#94a3b8", collapsed: true },
  nurture:       { label: "Nurture",       emoji: "🌱", color: "#65a30d", collapsed: true },
};

function renderDashboard(calls: CallSummary[]): string {
  const grouped: Record<CallState, CallSummary[]> = {
    new_lead: [],
    outreach_sent: [],
    quoted: [],
    negotiating: [],
    closed_won: [],
    closed_lost: [],
    nurture: [],
  };
  for (const c of calls) grouped[c.state].push(c);

  const stats = {
    total: calls.length,
    pipeline: grouped.new_lead.length + grouped.outreach_sent.length + grouped.quoted.length + grouped.negotiating.length,
    quoted: grouped.quoted.length,
    won: grouped.closed_won.length,
  };

  // Compute pipeline value (sum of budget_max for non-terminal stages)
  const pipelineCalls = [...grouped.new_lead, ...grouped.outreach_sent, ...grouped.quoted, ...grouped.negotiating];
  const pipelineValue = pipelineCalls.reduce((sum, c) => sum + (c.budget_max ?? c.budget_min ?? 0), 0);

  const activeStages: CallState[] = ["new_lead", "outreach_sent", "quoted", "negotiating"];
  const collapsedStages: CallState[] = ["closed_won", "closed_lost", "nurture"];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FerroLaser Sales Cockpit</title>
<style>
  :root {
    --bg: #f5f5f4;
    --card: #ffffff;
    --border: #e7e5e4;
    --text: #1c1917;
    --muted: #78716c;
    --accent: #0f766e;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.45;
  }
  header.top {
    background: linear-gradient(135deg, #0f766e 0%, #115e59 100%);
    color: #fff;
    padding: 18px 24px;
  }
  header.top h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  header.top .sub { font-size: 12px; opacity: 0.85; margin-top: 4px; }
  .stats {
    display: flex;
    gap: 16px;
    padding: 16px 24px;
    background: #fff;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  .stat {
    background: #fafaf9;
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 16px;
    min-width: 120px;
  }
  .stat .v { font-size: 22px; font-weight: 700; color: var(--accent); }
  .stat .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .board-wrap { padding: 20px; }
  .board {
    display: grid;
    grid-template-columns: repeat(4, minmax(240px, 1fr));
    gap: 14px;
    margin-bottom: 20px;
  }
  @media (max-width: 1100px) { .board { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 640px)  { .board { grid-template-columns: 1fr; } }
  .column {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
    min-height: 200px;
    border-top: 3px solid var(--accent);
  }
  .column h2 {
    margin: 0 0 12px;
    font-size: 13px;
    font-weight: 700;
    color: var(--text);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .column h2 .label-block { display: flex; align-items: center; gap: 6px; }
  .column h2 .count {
    background: #fafaf9;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 11px;
    font-weight: 600;
    color: var(--text);
  }
  .terminal-section {
    margin-top: 24px;
    padding: 14px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .terminal-section h3 {
    margin: 0 0 12px;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .terminal-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
  }
  @media (max-width: 800px) { .terminal-grid { grid-template-columns: 1fr; } }
  .terminal-col h4 {
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 600;
    display: flex;
    justify-content: space-between;
  }
  .terminal-col h4 .count { font-weight: 400; color: var(--muted); }
  .card-call {
    background: #fafaf9;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    margin-bottom: 8px;
    text-decoration: none;
    color: inherit;
    display: block;
    transition: transform 0.1s, box-shadow 0.1s;
  }
  .card-call:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(0,0,0,0.06);
  }
  .card-call .row1 {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 4px;
  }
  .card-call .phone {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px;
    font-weight: 600;
  }
  .card-call .call-count {
    background: #e0f2fe;
    color: #075985;
    border: 1px solid #7dd3fc;
    border-radius: 999px;
    padding: 1px 8px;
    font-size: 10px;
    font-weight: 600;
    margin-left: 6px;
    font-family: -apple-system, sans-serif;
  }
  .card-call .tier-pill {
    color: #fff;
    border-radius: 999px;
    padding: 2px 8px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .card-call .ident {
    font-size: 12px;
    color: var(--text);
    margin-top: 2px;
    font-weight: 600;
  }
  .card-call .persona {
    font-size: 12px;
    color: var(--text);
    margin-top: 2px;
    line-height: 1.3;
  }
  .card-call .research-line {
    font-size: 11px;
    color: #065f46;
    background: #ecfdf5;
    border: 1px solid #6ee7b7;
    border-radius: 4px;
    padding: 2px 6px;
    margin-top: 4px;
    display: inline-block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-call .research-line.pending {
    color: #92400e;
    background: #fffbeb;
    border-color: #fcd34d;
    font-style: italic;
  }
  .card-call .spec {
    font-size: 11px;
    color: var(--muted);
    margin-top: 3px;
  }
  .card-call .sku {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
    color: var(--accent);
    margin-top: 4px;
    font-weight: 600;
  }
  .card-call .stage-detail {
    font-size: 11px;
    color: #92400e;
    background: #fef3c7;
    border: 1px solid #fde68a;
    border-radius: 4px;
    padding: 2px 6px;
    margin-top: 6px;
    display: inline-block;
  }
  .card-call .chips-row {
    display: flex;
    gap: 3px;
    margin-top: 6px;
    flex-wrap: wrap;
  }
  .chip {
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 10px;
    border: 1px solid var(--border);
    background: #fff;
    color: var(--muted);
  }
  .chip.done { background: #dcfce7; border-color: #86efac; color: #166534; }
  .card-call .meta {
    font-size: 10px;
    color: var(--muted);
    margin-top: 6px;
    display: flex;
    gap: 8px;
  }
  .empty {
    text-align: center;
    color: var(--muted);
    font-style: italic;
    padding: 20px 0;
    font-size: 12px;
  }
</style>
</head>
<body>

<header class="top">
  <h1>🛠️ FerroLaser Sales Cockpit</h1>
  <div class="sub">CRM pipeline · AI drafts every outbound message, you review + send.</div>
</header>

<div class="stats">
  <div class="stat"><div class="v">${stats.total}</div><div class="l">Total leads (24h)</div></div>
  <div class="stat"><div class="v">${stats.pipeline}</div><div class="l">Active pipeline</div></div>
  <div class="stat"><div class="v">$${(pipelineValue / 1000).toFixed(0)}k</div><div class="l">Pipeline value</div></div>
  <div class="stat"><div class="v">${stats.won}</div><div class="l">Won</div></div>
</div>

<div class="board-wrap">

  <!-- Active stages — kanban -->
  <div class="board">
    ${activeStages
      .map((s) => {
        const col = COLUMN_LABELS[s];
        const cards = grouped[s];
        return `<div class="column" style="border-top-color:${col.color};">
          <h2>
            <span class="label-block">${col.emoji} ${col.label}</span>
            <span class="count">${cards.length}</span>
          </h2>
          ${cards.length === 0 ? `<div class="empty">no leads here</div>` : cards.map(renderCard).join("")}
        </div>`;
      })
      .join("")}
  </div>

  <!-- Terminal stages — collapsed grid -->
  <div class="terminal-section">
    <h3>Terminal stages</h3>
    <div class="terminal-grid">
      ${collapsedStages
        .map((s) => {
          const col = COLUMN_LABELS[s];
          const cards = grouped[s];
          return `<div class="terminal-col">
            <h4>
              <span>${col.emoji} ${col.label}</span>
              <span class="count">${cards.length}</span>
            </h4>
            ${cards.length === 0 ? `<div class="empty">none</div>` : cards.slice(0, 5).map(renderCard).join("")}
            ${cards.length > 5 ? `<div class="empty">+ ${cards.length - 5} more</div>` : ""}
          </div>`;
        })
        .join("")}
    </div>
  </div>

</div>

</body>
</html>`;
}
