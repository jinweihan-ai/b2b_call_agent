import type { Bindings } from "../types";
import { geminiJson } from "./gemini";
import { searchProducts, type ProductMemory } from "./supermemory";

// M3 post-call entity extraction via Gemini. Replaces the regex-only path
// for the replay page. Runs once at agent.call_ended, result cached in KV.
//
// Why Gemini over regex:
//   • Regex misses ASR drift ("still"→steel, "miles"→months)
//   • Regex can't infer when a user volunteered budget+timeline together
//   • Gemini can reason: "100 parts a week" is production volume, NOT budget
//   • Gemini can pick the best SKU from retrieved candidates with rationale

export interface GeminiEntities {
  material: string | null;
  thickness_mm: number | null;
  budget_usd_min: number | null;
  budget_usd_max: number | null;
  timeline_weeks: number | null;
  application: string | null; // e.g. "sign making", "sheet metal fabrication"
  recommended_sku: string | null;
  recommended_reason: string | null;
  qual_score: number; // 0-100
  qual_tier: string; // hot/warm/cool/cold
  concerns: string[]; // e.g. "budget below floor", "timeline too aggressive"
  buyer_persona: string | null; // e.g. "small sign shop owner"
  // Caller identity — used by the Browser Use background-check action to
  // search for the company online. Null when the caller didn't volunteer it.
  caller_name: string | null;
  caller_company: string | null;
}

const SYSTEM_INSTRUCTION = `You are a B2B sales analyst extracting structured lead data from a recorded laser cutter sales call transcript.

You receive:
1. The full call transcript (turns of agent + user)
2. A list of available products in the catalog

Your job: extract the buyer's requirements, score them, recommend the best matching product, and flag concerns.

Rules:
• ASR is noisy. Use context: "still" usually means "steel", "miles" usually means "months", "weight" means "week", "label" means "laser", "science shop" means "sign shop", "anode/ollum" means "aluminum", "one part hundred" means "one hundred parts".
• Side conversations / "(inaudible speech)" / random bystander chatter → ignore those turns.
• budget_usd_min/max: extract a USD range. "twenty five thousand" → both 25000. "25k to 30k" → 25000, 30000.
• timeline_weeks: convert all timelines to weeks. "two months" → 8. "ASAP" → 4.
• qual_score: 0-100. Base on how complete the qualification is + budget fit + timeline realism. 100 = perfect lead, 0 = useless. This field IS allowed to be 0.
• qual_tier: "hot" (≥75), "warm" (50-74), "cool" (25-49), "cold" (<25).
• recommended_sku: MUST be a SKU from the catalog provided. NEVER invent. OMIT this field (don't include it) if no catalog match.
• recommended_reason: ONE clause explaining the match — e.g. "1.5kW fiber handles 6mm aluminum, fits $25k budget, ships in 6 weeks". OMIT if no recommendation.
• concerns: array of red flags. Empty array [] if none. Common concerns: "no requirements specified", "budget too low for product tier", "wrong material category for our catalog".
• caller_name: the caller's personal name if they introduced themselves (e.g. "Ron", "Sarah Chen"). OMIT if they never said.
• caller_company: the name of their business (e.g. "Texas Headstone Co", "Ron's Signs"). OMIT if they never said. Distinct from buyer_persona which is a generic descriptor like "sign shop owner".

CRITICAL NULL RULE: When a piece of information was NOT mentioned by the caller, OMIT that field from the JSON entirely OR set it to JSON null. Do NOT use the strings "null"/"unknown"/"N/A"/"none". Do NOT use 0 to mean "unspecified" — 0 only when the caller literally said zero.

Return STRICT JSON only. No markdown. First char {, last char }.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    material: { type: "string" },
    thickness_mm: { type: "number" },
    budget_usd_min: { type: "number" },
    budget_usd_max: { type: "number" },
    timeline_weeks: { type: "number" },
    application: { type: "string" },
    recommended_sku: { type: "string" },
    recommended_reason: { type: "string" },
    qual_score: { type: "number" },
    qual_tier: { type: "string" },
    concerns: { type: "array", items: { type: "string" } },
    buyer_persona: { type: "string" },
    caller_name: { type: "string" },
    caller_company: { type: "string" },
  },
  required: ["qual_score", "qual_tier"],
};

function normalize(raw: Record<string, unknown> | null): GeminiEntities | null {
  if (!raw) return null;
  const pickStr = (k: string): string | null => {
    const v = raw[k];
    if (typeof v !== "string") return null;
    const t = v.trim();
    if (t.length === 0) return null;
    // Gemini sometimes returns the literal string "null" / "undefined" / "N/A"
    // when it should have returned actual null. Map those back to null.
    const tl = t.toLowerCase();
    if (tl === "null" || tl === "undefined" || tl === "n/a" || tl === "none" || tl === "not specified" || tl === "unknown") return null;
    return t;
  };
  // For numeric fields where 0 is NOT a meaningful "given" value (budget,
  // thickness, timeline), treat 0 as "not specified".
  const pickNumNonZero = (k: string): number | null => {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return v > 0 ? v : null;
  };
  const pickArr = (k: string): string[] => {
    const v = raw[k];
    if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
    return [];
  };
  // qual_score is a 0-100 number where 0 IS meaningful (very cold lead).
  const rawScore = raw["qual_score"];
  const score = typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : 0;
  return {
    material: pickStr("material"),
    thickness_mm: pickNumNonZero("thickness_mm"),
    budget_usd_min: pickNumNonZero("budget_usd_min"),
    budget_usd_max: pickNumNonZero("budget_usd_max"),
    timeline_weeks: pickNumNonZero("timeline_weeks"),
    application: pickStr("application"),
    recommended_sku: pickStr("recommended_sku"),
    recommended_reason: pickStr("recommended_reason"),
    qual_score: Math.max(0, Math.min(100, Math.round(score))),
    qual_tier: pickStr("qual_tier") ?? "cold",
    concerns: pickArr("concerns"),
    buyer_persona: pickStr("buyer_persona"),
    caller_name: pickStr("caller_name"),
    caller_company: pickStr("caller_company"),
  };
}

// Build a flat transcript string from the call_ended payload.
function transcriptFromPayload(payload: Record<string, unknown>): string {
  const d = (payload.data ?? payload) as Record<string, unknown>;
  const t = d.transcript;
  if (typeof t === "string") return t;
  if (Array.isArray(t)) {
    return (t as Array<Record<string, unknown>>)
      .map((m) => `${m.role ?? "?"}: ${String(m.content ?? "")}`)
      .join("\n");
  }
  return "";
}

export async function extractEntitiesGemini(
  env: Bindings,
  payload: Record<string, unknown>
): Promise<GeminiEntities | null> {
  const transcript = transcriptFromPayload(payload);
  if (!transcript || transcript.length < 20) {
    console.log("[extract-gemini] transcript too short, skipping");
    return null;
  }

  // Retrieve top relevant products to ground the recommendation
  let products: ProductMemory[] = [];
  try {
    products = await searchProducts(env, transcript.slice(0, 1000), 5);
  } catch (err) {
    console.warn("[extract-gemini] supermemory search failed:", err);
  }

  const catalogBlock = products.length
    ? "Catalog:\n" +
      products
        .map((p) => `• ${p.sku} — ${p.name} — ${p.content}`)
        .join("\n")
    : "Catalog: (no matches retrieved)";

  const userPrompt = `Transcript:\n${transcript}\n\n${catalogBlock}\n\nExtract structured lead data as JSON.`;

  const raw = await geminiJson(env, {
    systemInstruction: SYSTEM_INSTRUCTION,
    userPrompt,
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: 1024,
    temperature: 0.2,
    timeoutMs: 8000, // longer budget — this is post-call, not voice in-progress
  });

  const normalized = normalize(raw);
  if (normalized) {
    console.log(
      `[extract-gemini] tier=${normalized.qual_tier} score=${normalized.qual_score} sku=${normalized.recommended_sku} material=${normalized.material}`
    );
  } else {
    console.warn("[extract-gemini] Gemini returned no usable output");
  }
  return normalized;
}
