import type { Bindings } from "../types";
import { geminiJson } from "./gemini";
import { searchProducts, type ProductMemory } from "./supermemory";
import type { CallDrafts } from "./render";
import type { GeminiEntities } from "./extract-gemini";

// M4 — generate 3 outbound drafts in ONE Gemini call after a call_ended:
//   1. customer_sms — short ASCII SMS sent via Agent Phone outbound API
//   2. supplier_rfq — Chinese RFQ posted to #sourcing-china Slack channel
//   3. briefing — markdown briefing for the US-side sales rep
//
// All three are DRAFTS — they appear in the dashboard awaiting human review
// + edit + click-to-send. AI is the autopilot, the sales rep is accountable.

const SYSTEM_INSTRUCTION = `You are an inside-sales operations AI for FerroLaser, a Chinese laser-cutter manufacturer selling into the US small-business market.

A US customer just called and was qualified by our voice agent. You will receive: the call transcript, the extracted entities, the recommended product from our catalog.

Your job: draft THREE outbound artifacts that a US-side sales rep will REVIEW and SEND. Each is editable — be a great first draft.

ARTIFACT 1 — customer_sms (English, ASCII only, plain text)
• Send via SMS to the caller's phone.
• Max 280 chars (~2 SMS segments). Friendly, professional. NO emojis, NO non-ASCII.
• Reference what they said by NAME if they gave one and by their use case.
• Mention the recommended SKU + 1 key spec match.
• Include the literal token {PRODUCT_URL} as a placeholder — the system will substitute the real URL.
• End with "— FerroLaser Sales" so the recipient knows who it's from.

ARTIFACT 2 — supplier_rfq (Simplified Chinese)
• Internal email to FerroLaser China production team — confirming the deal is real + asking for capacity check, accurate lead time, and pricing.
• Format: Chinese business email. Headline line, bulleted requirements, ask, sign-off.
• Include: recommended SKU, customer's material + thickness + volume + budget + timeline + buyer persona, any cross-cultural notes (e.g., customer expects English support, US shipping address pending).
• Plain text, no markdown. Max 500 chars Chinese.
• Mention the call_id so the China team can cross-reference.

ARTIFACT 3 — briefing (markdown, English)
• For the US-side sales rep about to call this lead back.
• Sections (use markdown headers): **TL;DR** (1 line), **Customer** (name + persona + company if hinted), **Specs** (bullets), **Recommended product** (SKU + why fit), **Talking points** (3 bullets of what to say next), **Avoid** (1 bullet — anything risky to mention prematurely, e.g., final price before factory confirms), **Next step** (1 line).
• Tight, scannable. Max 600 chars.

OUTPUT: STRICT JSON {customer_sms, supplier_rfq, briefing}. Raw JSON only. First char {, last char }. No markdown fences, no preamble.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    customer_sms: { type: "string" },
    supplier_rfq: { type: "string" },
    briefing: { type: "string" },
  },
  required: ["customer_sms", "supplier_rfq", "briefing"],
};

function buildContextBlock(
  callId: string,
  transcript: string,
  entities: GeminiEntities | null,
  callerPhone: string | null,
  products: ProductMemory[],
  productUrl: string | null
): string {
  const lines: string[] = [];
  lines.push(`Call ID: ${callId}`);
  if (callerPhone) lines.push(`Caller phone: ${callerPhone}`);
  if (entities) {
    if (entities.buyer_persona) lines.push(`Buyer persona: ${entities.buyer_persona}`);
    if (entities.application) lines.push(`Application: ${entities.application}`);
    if (entities.material) lines.push(`Material: ${entities.material}`);
    if (entities.thickness_mm !== null) lines.push(`Thickness: ${entities.thickness_mm} mm`);
    if (entities.budget_usd_min !== null || entities.budget_usd_max !== null) {
      const min = entities.budget_usd_min ?? entities.budget_usd_max ?? "?";
      const max = entities.budget_usd_max ?? entities.budget_usd_min ?? "?";
      lines.push(`Budget: $${min} - $${max} USD`);
    }
    if (entities.timeline_weeks !== null) lines.push(`Timeline: ${entities.timeline_weeks} weeks`);
    if (entities.recommended_sku) {
      lines.push(`Recommended SKU (from agent): ${entities.recommended_sku}`);
    }
    if (entities.recommended_reason) {
      lines.push(`Why fit: ${entities.recommended_reason}`);
    }
    lines.push(`Qual score: ${entities.qual_score}/100 (${entities.qual_tier})`);
    if (entities.concerns?.length) {
      lines.push(`Concerns: ${entities.concerns.join("; ")}`);
    }
  }
  if (products.length) {
    lines.push("");
    lines.push("Catalog candidates:");
    for (const p of products) {
      lines.push(`  • ${p.sku} — ${p.name}`);
    }
  }
  lines.push("");
  lines.push("Transcript:");
  lines.push(transcript.slice(0, 2000));
  if (productUrl) {
    lines.push("");
    lines.push(`Product URL placeholder will substitute: ${productUrl}`);
  }
  return lines.join("\n");
}

export async function generateDrafts(
  env: Bindings,
  args: {
    callId: string;
    transcript: string;
    entities: GeminiEntities | null;
    callerPhone: string | null;
    productUrl: string | null;
  }
): Promise<CallDrafts | null> {
  if (!args.transcript || args.transcript.length < 20) {
    console.log("[drafts] transcript too short, skipping");
    return null;
  }

  // Retrieve catalog context for grounding (mostly to help the briefing
  // reference fit-rationale; recommendation already came from entities).
  let products: ProductMemory[] = [];
  try {
    products = await searchProducts(
      env,
      (args.entities?.recommended_sku || args.transcript).slice(0, 300),
      4
    );
  } catch (err) {
    console.warn("[drafts] supermemory search failed:", err);
  }

  const userPrompt = buildContextBlock(
    args.callId,
    args.transcript,
    args.entities,
    args.callerPhone,
    products,
    args.productUrl
  );

  const raw = await geminiJson(env, {
    systemInstruction: SYSTEM_INSTRUCTION,
    userPrompt,
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: 2048, // 3 artifacts — needs headroom
    temperature: 0.5,
    model: "gemini-2.5-flash",
    timeoutMs: 15000, // post-call, no live latency pressure
  });

  if (!raw) {
    console.warn("[drafts] gemini returned null");
    return null;
  }

  const customer_sms = String(raw.customer_sms ?? "").trim();
  const supplier_rfq = String(raw.supplier_rfq ?? "").trim();
  const briefing = String(raw.briefing ?? "").trim();

  if (!customer_sms && !supplier_rfq && !briefing) {
    console.warn("[drafts] gemini returned empty drafts");
    return null;
  }

  console.log(
    `[drafts] generated: sms=${customer_sms.length}ch, rfq=${supplier_rfq.length}ch, brief=${briefing.length}ch`
  );

  // Substitute {PRODUCT_URL} placeholder if we have a real URL handy.
  const substitute = (s: string): string =>
    args.productUrl ? s.replace(/\{PRODUCT_URL\}/g, args.productUrl) : s;

  return {
    customer_sms: substitute(customer_sms),
    supplier_rfq: substitute(supplier_rfq),
    briefing: substitute(briefing),
  };
}
