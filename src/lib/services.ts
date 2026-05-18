import type { Bindings } from "../types";
import type { CallRecord, CallState, CallActions, CallDrafts } from "./render";
import { normalizeState } from "./render";
import type { GeminiEntities } from "./extract-gemini";
import type { LeadIndex, LeadResearch } from "./leads";
import {
  getLead,
  saveLead,
  normalizePhone,
  appendCallToLead,
} from "./leads";
import {
  loadRecord,
  saveRecord,
  withStateChange,
  getCallerPhone,
  getAgentId,
  sendAgentPhoneSms,
} from "./call-io";
import { createResearchTask } from "./browser-use";
import { searchProducts as supermemorySearch, type ProductMemory } from "./supermemory";
import productsJson from "../data/products.json";

// ─── Common result envelope ──────────────────────────────────────────
//
// Every service function returns ServiceResult<T>. REST handlers map status
// to HTTP code; MCP handlers map status to JSON-RPC error code.
export interface ServiceOk<T> {
  ok: true;
  data: T;
}
export interface ServiceErr {
  ok: false;
  code: string;
  message: string;
  status: number;
}
export type ServiceResult<T> = ServiceOk<T> | ServiceErr;

const ok = <T>(data: T): ServiceOk<T> => ({ ok: true, data });
const err = (code: string, message: string, status = 400): ServiceErr => ({
  ok: false,
  code,
  message,
  status,
});

// ─── Output shapes ───────────────────────────────────────────────────

export interface PersonSummary {
  phone: string;
  display_name: string | null;
  call_count: number;
  last_seen: string;
  latest_call_id: string | null;
  latest_state: CallState | null;
  latest_tier: string | null;
  latest_score: number | null;
  // From the latest call's Gemini extraction. Lets MCP/REST consumers
  // filter on industry without having to load the full call detail.
  latest_buyer_persona: string | null;
  latest_application: string | null;
  research_status: "pending" | "done" | "failed" | null;
  research_company: string | null;
  research_industry: string | null;
}

export interface PersonDetail extends PersonSummary {
  calls: Array<{ call_id: string; received_at: string }>;
  research: LeadResearch | null;
}

export interface CallSummary {
  call_id: string;
  received_at: string;
  caller_phone: string | null;
  duration_seconds: number | null;
  state: CallState;
  score: number;
  tier: string;
  caller_name: string | null;
  caller_company: string | null;
  buyer_persona: string | null;
  application: string | null;
  material: string | null;
  thickness_mm: number | null;
  budget_usd_min: number | null;
  budget_usd_max: number | null;
  timeline_weeks: number | null;
  recommended_sku: string | null;
  customer_sms_sent: boolean;
  supplier_rfq_sent: boolean;
  briefing_acked: boolean;
  outcome: "won" | "lost" | "nurture" | null;
}

export interface CallDetail extends CallSummary {
  transcript: Array<{ role: string; content: string }>;
  agent_phone_summary: string | null;
  user_sentiment: string | null;
  call_successful: boolean | null;
  agent_id: string | null;
  recording_url: string | null;
  replay_url: string | null;
  slack_text: string | null;
  entities: GeminiEntities | null;
  actions: CallActions;
  drafts: CallDrafts | null;
  drafts_generated_at: string | null;
  recommended_reason: string | null;
}

export interface CatalogProduct {
  sku: string;
  name: string;
  power_w: number;
  working_area_mm: [number, number];
  max_steel_thickness_mm: number;
  price_usd_range: [number, number];
  lead_time_weeks: number;
  product_url?: string;
  [k: string]: unknown;
}

// ─── Internal extractors ─────────────────────────────────────────────

function readPayloadField<T = unknown>(p: Record<string, unknown>, key: string): T | null {
  const d = (p.data ?? p) as Record<string, unknown>;
  if (d[key] !== undefined) return d[key] as T;
  if (p[key] !== undefined) return p[key] as T;
  return null;
}

function summarizeCall(rec: CallRecord): CallSummary {
  const ent = rec.entities ?? null;
  const a = rec.actions ?? {};
  const p = rec.payload as Record<string, unknown>;
  return {
    call_id: rec.call_id,
    received_at: rec.received_at,
    caller_phone: typeof readPayloadField<string>(p, "from") === "string"
      ? readPayloadField<string>(p, "from")
      : (typeof readPayloadField<string>(p, "caller_phone") === "string"
        ? readPayloadField<string>(p, "caller_phone")
        : null),
    duration_seconds: typeof readPayloadField<number>(p, "durationSeconds") === "number"
      ? readPayloadField<number>(p, "durationSeconds")
      : null,
    state: normalizeState(rec.state),
    score: ent?.qual_score ?? 0,
    tier: ent?.qual_tier ?? "cold",
    caller_name: ent?.caller_name ?? null,
    caller_company: ent?.caller_company ?? null,
    buyer_persona: ent?.buyer_persona ?? null,
    application: ent?.application ?? null,
    material: ent?.material ?? null,
    thickness_mm: ent?.thickness_mm ?? null,
    budget_usd_min: ent?.budget_usd_min ?? null,
    budget_usd_max: ent?.budget_usd_max ?? null,
    timeline_weeks: ent?.timeline_weeks ?? null,
    recommended_sku: ent?.recommended_sku ?? null,
    customer_sms_sent: !!a.customer_sms,
    supplier_rfq_sent: !!a.supplier_rfq,
    briefing_acked: !!a.briefing,
    outcome: a.outcome ?? null,
  };
}

function detailCall(rec: CallRecord): CallDetail {
  const summary = summarizeCall(rec);
  const p = rec.payload as Record<string, unknown>;
  const transcriptRaw = readPayloadField<unknown>(p, "transcript");
  const transcript = Array.isArray(transcriptRaw)
    ? (transcriptRaw as Array<Record<string, unknown>>)
        .map((m) => ({ role: String(m.role ?? "?"), content: String(m.content ?? "") }))
        .filter((m) => m.content.length > 0)
    : [];
  const ent = rec.entities ?? null;
  return {
    ...summary,
    transcript,
    agent_phone_summary: typeof readPayloadField<string>(p, "summary") === "string"
      ? readPayloadField<string>(p, "summary")
      : null,
    user_sentiment: typeof readPayloadField<string>(p, "userSentiment") === "string"
      ? readPayloadField<string>(p, "userSentiment")
      : null,
    call_successful: typeof readPayloadField<boolean>(p, "callSuccessful") === "boolean"
      ? readPayloadField<boolean>(p, "callSuccessful")
      : null,
    agent_id: typeof readPayloadField<string>(p, "agentId") === "string"
      ? readPayloadField<string>(p, "agentId")
      : (typeof readPayloadField<string>(p, "agent_id") === "string"
        ? readPayloadField<string>(p, "agent_id")
        : null),
    recording_url: rec.recording_url ?? null,
    replay_url: rec.replay_url ?? null,
    slack_text: rec.slack_text ?? null,
    entities: ent,
    actions: rec.actions ?? {},
    drafts: rec.drafts ?? null,
    drafts_generated_at: rec.drafts_generated_at ?? null,
    recommended_reason: ent?.recommended_reason ?? null,
  };
}

function summarizePerson(lead: LeadIndex, latest: CallRecord | null): PersonSummary {
  const ent = latest?.entities ?? null;
  return {
    phone: lead.phone,
    display_name: lead.display_name ?? null,
    call_count: lead.calls.length,
    last_seen: lead.last_seen,
    latest_call_id: latest?.call_id ?? null,
    latest_state: latest ? normalizeState(latest.state) : null,
    latest_tier: ent?.qual_tier ?? null,
    latest_score: ent?.qual_score ?? null,
    latest_buyer_persona: ent?.buyer_persona ?? null,
    latest_application: ent?.application ?? null,
    research_status: lead.research?.status ?? null,
    research_company: lead.research?.company_name ?? null,
    research_industry: lead.research?.industry ?? null,
  };
}

// ─── Person services ─────────────────────────────────────────────────

export async function listPersons(
  env: Bindings,
  limit = 200
): Promise<ServiceResult<{ persons: PersonSummary[] }>> {
  const persons: PersonSummary[] = [];
  try {
    const listing = await env.CALLS.list({ limit });
    const leadKeys = listing.keys.filter((k) => k.name.startsWith("lead:"));
    for (const k of leadKeys) {
      const raw = await env.CALLS.get(k.name);
      if (!raw) continue;
      let lead: LeadIndex;
      try {
        lead = JSON.parse(raw) as LeadIndex;
      } catch {
        continue;
      }
      let latest: CallRecord | null = null;
      const latestEntry = lead.calls[0];
      if (latestEntry) {
        latest = await loadRecord(env, latestEntry.call_id);
      }
      persons.push(summarizePerson(lead, latest));
    }
  } catch (e) {
    return err("kv_list_failed", (e as Error).message, 500);
  }
  persons.sort((a, b) => b.last_seen.localeCompare(a.last_seen));
  return ok({ persons });
}

export async function getPerson(
  env: Bindings,
  rawPhone: string
): Promise<ServiceResult<{ person: PersonDetail }>> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return err("invalid_phone", `cannot parse phone: ${rawPhone}`, 400);
  const lead = await getLead(env, phone);
  if (!lead) return err("not_found", `no lead for phone ${phone}`, 404);
  const latestEntry = lead.calls[0];
  const latest = latestEntry ? await loadRecord(env, latestEntry.call_id) : null;
  const person: PersonDetail = {
    ...summarizePerson(lead, latest),
    calls: lead.calls,
    research: lead.research ?? null,
  };
  return ok({ person });
}

export async function renamePerson(
  env: Bindings,
  rawPhone: string,
  displayName: string | null
): Promise<ServiceResult<{ person: PersonDetail }>> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return err("invalid_phone", `cannot parse phone: ${rawPhone}`, 400);
  const trimmed = displayName?.trim() ?? "";
  const next = trimmed.length > 0 ? trimmed : null;
  const lead = (await getLead(env, phone)) ?? {
    phone,
    calls: [],
    last_seen: new Date().toISOString(),
  };
  lead.display_name = next;
  await saveLead(env, lead);
  console.log(`[services] renamed ${phone} → ${next ?? "(cleared)"}`);
  return getPerson(env, phone);
}

export async function startResearch(
  env: Bindings,
  rawPhone: string
): Promise<ServiceResult<{ research: LeadResearch }>> {
  const phone = normalizePhone(rawPhone);
  if (!phone) return err("invalid_phone", `cannot parse phone: ${rawPhone}`, 400);
  const existing = await getLead(env, phone);
  if (existing?.research?.status === "pending") {
    return ok({ research: existing.research });
  }

  // Need a call's entities for context. Use the latest call if available.
  let ent: GeminiEntities | null = null;
  if (existing && existing.calls.length > 0) {
    const latest = await loadRecord(env, existing.calls[0].call_id);
    ent = latest?.entities ?? null;
  }

  const result = await createResearchTask(env, {
    phone,
    caller_name: ent?.caller_name ?? null,
    caller_company: ent?.caller_company ?? null,
    application: ent?.application ?? null,
    material: ent?.material ?? null,
    budget_usd: ent?.budget_usd_max ?? ent?.budget_usd_min ?? null,
  });
  if (!result.ok) {
    return err("research_kickoff_failed", result.error, 502);
  }

  const lead: LeadIndex = existing ?? {
    phone,
    calls: [],
    last_seen: new Date().toISOString(),
  };
  lead.research = {
    task_id: result.session_id,
    status: "pending",
    started_at: new Date().toISOString(),
    live_url: result.live_url ?? null,
    raw_output: null,
  };
  await saveLead(env, lead);
  return ok({ research: lead.research });
}

// ─── Call services ───────────────────────────────────────────────────

export async function listCalls(
  env: Bindings,
  limit = 200
): Promise<ServiceResult<{ calls: CallSummary[] }>> {
  const calls: CallSummary[] = [];
  try {
    const listing = await env.CALLS.list({ limit });
    const callKeys = listing.keys.filter((k) => !k.name.startsWith("lead:"));
    for (const k of callKeys) {
      const raw = await env.CALLS.get(k.name);
      if (!raw) continue;
      let rec: CallRecord;
      try {
        rec = JSON.parse(raw) as CallRecord;
      } catch {
        continue;
      }
      if (!rec.call_id) continue;
      calls.push(summarizeCall(rec));
    }
  } catch (e) {
    return err("kv_list_failed", (e as Error).message, 500);
  }
  calls.sort((a, b) => (b.received_at ?? "").localeCompare(a.received_at ?? ""));
  return ok({ calls });
}

export async function getCall(
  env: Bindings,
  callId: string
): Promise<ServiceResult<{ call: CallDetail }>> {
  const rec = await loadRecord(env, callId);
  if (!rec) return err("not_found", `call ${callId} not found`, 404);
  return ok({ call: detailCall(rec) });
}

export async function sendCustomerSmsAction(
  env: Bindings,
  callId: string,
  text: string
): Promise<ServiceResult<{ call: CallDetail; message_id: string | null }>> {
  const trimmed = text.trim();
  if (!trimmed) return err("invalid_input", "text is required", 400);
  const rec = await loadRecord(env, callId);
  if (!rec) return err("not_found", `call ${callId} not found`, 404);
  const callerPhone = getCallerPhone(rec);
  if (!callerPhone) return err("no_caller_phone", "call has no caller phone to send to", 422);
  const agentId = getAgentId(rec);
  if (!agentId) return err("no_agent_id", "call has no agent_id", 422);
  const result = await sendAgentPhoneSms(env, agentId, callerPhone, trimmed);
  if (!result.ok) return err("agent_phone_failed", result.error ?? "unknown", 502);
  rec.actions = {
    ...(rec.actions ?? {}),
    customer_sms: {
      sent_at: new Date().toISOString(),
      sent_text: trimmed,
      message_id: result.id,
    },
  };
  withStateChange(rec);
  await saveRecord(env, rec);
  return ok({ call: detailCall(rec), message_id: result.id ?? null });
}

export async function sendSupplierRfqAction(
  env: Bindings,
  callId: string,
  text: string
): Promise<ServiceResult<{ call: CallDetail }>> {
  const trimmed = text.trim();
  if (!trimmed) return err("invalid_input", "text is required", 400);
  const rec = await loadRecord(env, callId);
  if (!rec) return err("not_found", `call ${callId} not found`, 404);
  const hasSourcing =
    typeof env.SOURCING_WEBHOOK_URL === "string" && env.SOURCING_WEBHOOK_URL.length > 0;
  const sourcingUrl = hasSourcing ? env.SOURCING_WEBHOOK_URL! : env.SLACK_WEBHOOK_URL;
  if (!sourcingUrl) return err("no_sourcing_webhook", "no Slack sourcing webhook configured", 503);
  const message = hasSourcing
    ? trimmed
    : `🇨🇳 *[SOURCING CHINA — RFQ for call ${callId}]*\n\n${trimmed}`;
  try {
    const resp = await fetch(sourcingUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return err("slack_failed", `${resp.status}: ${t.slice(0, 200)}`, 502);
    }
  } catch (e) {
    return err("slack_failed", (e as Error).message, 502);
  }
  rec.actions = {
    ...(rec.actions ?? {}),
    supplier_rfq: { sent_at: new Date().toISOString(), sent_text: trimmed },
  };
  withStateChange(rec);
  await saveRecord(env, rec);
  return ok({ call: detailCall(rec) });
}

export async function ackBriefingAction(
  env: Bindings,
  callId: string
): Promise<ServiceResult<{ call: CallDetail }>> {
  const rec = await loadRecord(env, callId);
  if (!rec) return err("not_found", `call ${callId} not found`, 404);
  rec.actions = {
    ...(rec.actions ?? {}),
    briefing: { acked_at: new Date().toISOString() },
  };
  withStateChange(rec);
  await saveRecord(env, rec);
  return ok({ call: detailCall(rec) });
}

export interface MoveToQuotedArgs {
  factory_price_usd?: number | null;
  factory_lead_time_weeks?: number | null;
  notes?: string | null;
}
export async function moveToQuotedAction(
  env: Bindings,
  callId: string,
  args: MoveToQuotedArgs
): Promise<ServiceResult<{ call: CallDetail }>> {
  const rec = await loadRecord(env, callId);
  if (!rec) return err("not_found", `call ${callId} not found`, 404);
  const now = new Date().toISOString();
  rec.actions = {
    ...(rec.actions ?? {}),
    quote: {
      factory_confirmed_at: now,
      factory_price_usd:
        typeof args.factory_price_usd === "number" && Number.isFinite(args.factory_price_usd)
          ? args.factory_price_usd
          : undefined,
      factory_lead_time_weeks:
        typeof args.factory_lead_time_weeks === "number" && Number.isFinite(args.factory_lead_time_weeks)
          ? args.factory_lead_time_weeks
          : undefined,
      quote_sent_to_customer_at: now,
      notes: args.notes ?? undefined,
    },
  };
  withStateChange(rec);
  await saveRecord(env, rec);
  return ok({ call: detailCall(rec) });
}

export interface MoveToNegotiatingArgs {
  sentiment?: "positive" | "negotiating" | "objecting" | null;
  notes?: string | null;
}
export async function moveToNegotiatingAction(
  env: Bindings,
  callId: string,
  args: MoveToNegotiatingArgs
): Promise<ServiceResult<{ call: CallDetail }>> {
  const rec = await loadRecord(env, callId);
  if (!rec) return err("not_found", `call ${callId} not found`, 404);
  rec.actions = {
    ...(rec.actions ?? {}),
    customer_response: {
      received_at: new Date().toISOString(),
      sentiment: args.sentiment ?? undefined,
      notes: args.notes ?? undefined,
    },
  };
  withStateChange(rec);
  await saveRecord(env, rec);
  return ok({ call: detailCall(rec) });
}

export async function setOutcomeAction(
  env: Bindings,
  callId: string,
  outcome: "won" | "lost" | "nurture",
  note: string | null
): Promise<ServiceResult<{ call: CallDetail }>> {
  if (outcome !== "won" && outcome !== "lost" && outcome !== "nurture") {
    return err("invalid_input", `outcome must be won|lost|nurture, got ${outcome}`, 400);
  }
  const rec = await loadRecord(env, callId);
  if (!rec) return err("not_found", `call ${callId} not found`, 404);
  rec.actions = {
    ...(rec.actions ?? {}),
    outcome,
    outcome_at: new Date().toISOString(),
    outcome_note: note ?? undefined,
  };
  withStateChange(rec);
  await saveRecord(env, rec);
  return ok({ call: detailCall(rec) });
}

// ─── Product services ────────────────────────────────────────────────

interface CatalogShape {
  products: CatalogProduct[];
}
const CATALOG = productsJson as unknown as CatalogShape;

export function listProducts(): ServiceResult<{ products: CatalogProduct[] }> {
  return ok({ products: CATALOG.products });
}

export async function searchProductsAction(
  env: Bindings,
  query: string
): Promise<ServiceResult<{ results: ProductMemory[] }>> {
  const q = query.trim();
  if (!q) return err("invalid_input", "query is required", 400);
  try {
    const results = await supermemorySearch(env, q, 8);
    return ok({ results });
  } catch (e) {
    return err("supermemory_failed", (e as Error).message, 502);
  }
}

// ─── Admin / utility ─────────────────────────────────────────────────

// Lets the API expose the lead-index backfill that admin/reindex uses.
// Kept here so MCP agents can invoke it as a tool.
export async function reindexLeadsAction(
  env: Bindings
): Promise<ServiceResult<{ scanned: number; indexed: number }>> {
  let scanned = 0;
  let indexed = 0;
  try {
    let cursor: string | undefined = undefined;
    do {
      const listing: { keys: { name: string }[]; list_complete: boolean; cursor?: string } =
        await env.CALLS.list({ limit: 1000, cursor });
      for (const k of listing.keys) {
        scanned++;
        if (k.name.startsWith("lead:")) continue;
        const raw = await env.CALLS.get(k.name);
        if (!raw) continue;
        let rec: CallRecord;
        try {
          rec = JSON.parse(raw) as CallRecord;
        } catch {
          continue;
        }
        const d = (rec.payload?.data ?? rec.payload ?? {}) as Record<string, unknown>;
        const phoneRaw =
          (typeof d.from === "string" ? d.from : null) ??
          (typeof d.caller_phone === "string" ? (d.caller_phone as string) : null);
        const norm = normalizePhone(phoneRaw);
        if (!norm) continue;
        await appendCallToLead(env, norm, rec.call_id, rec.received_at);
        indexed++;
      }
      cursor = listing.list_complete ? undefined : listing.cursor;
    } while (cursor);
  } catch (e) {
    return err("kv_list_failed", (e as Error).message, 500);
  }
  return ok({ scanned, indexed });
}
