import type { Bindings } from "../types";
import { searchProducts, type ProductMemory } from "../lib/supermemory";
import { geminiJson } from "../lib/gemini";

// M3 voice-reply: Gemini 2.5 Flash JSON mode + Supermemory retrieval + FSM
// fallback. Latency-optimized but not streaming (we tried NDJSON streaming —
// only saved ~100-200ms on short voice replies because Gemini's pre-fill
// dominates, and TTS sometimes split numbers mid-word; not worth the
// complexity. Kept gemini-stream.ts dormant for future longer-output use).
//
// Optimizations vs M2:
//   • gemini-2.5-flash (NOT lite — lite regressed on multi-turn recommend)
//   • thinkingConfig: { thinkingBudget: 0 } — disable extended thinking
//   • maxOutputTokens 256 — voice replies are <30 words
//   • Skip Supermemory on turn 1 (no agent history → always open question)
//   • Trim history to last 8 turns, each capped at 150 chars
//   • Compact system prompt (~30% smaller)
//   • Single log line per request (no full-body dump in hot path)
//   • Race against 2.8s hard wall (FSM fallback if exceeded)

const FILLER_WORDS = new Set([
  "yeah", "yep", "yup", "ya", "yes",
  "no", "nope", "nah",
  "hi", "hello", "hey",
  "ok", "okay", "k",
  "sure", "right", "alright",
  "um", "uh", "uhh", "uhhh", "hmm", "mhmm", "mm", "mmm",
  "well", "so",
  "agent", "operator",
  "i think", "let me think", "let me see", "hold on", "wait",
  "actually", "uh let me",
]);

const STALL_TEXT =
  "I'm sorry, could you say that again? I want to make sure I understand what you need.";

function isStallable(rawMsg: string | undefined | null): boolean {
  if (!rawMsg) return true;
  const cleaned = rawMsg.toLowerCase().trim().replace(/[.,!?;:\s]+$/g, "");
  if (cleaned.length === 0) return true;
  if (FILLER_WORDS.has(cleaned)) return true;
  if (/^\(inaudible/i.test(cleaned)) return true;
  if (cleaned.length < 3 && !/^\d/.test(cleaned)) return true;
  return false;
}

// ── FSM fallback (last-resort safety net for Gemini failure/timeout) ──
const TURN_1_MARKER = "point you to the right machine";
const TURN_2_MARKER = "budget range, plus when";
const TURN_1_TEXT =
  "Thanks for calling. To point you to the right machine, what material and thickness are you cutting?";
const TURN_2_TEXT =
  "Got it. What's your budget range, plus when do you need it delivered?";
const TURN_3_TEXT =
  "Perfect. A laser specialist will call you back within the hour with a tailored quote. Thanks for your interest!";

function fsmFallback(
  history: Array<{ role: string; content: string }>
): Record<string, unknown> {
  const agentSaid = history
    .filter((m) => m.role === "agent" || m.role === "outbound")
    .map((m) => m.content)
    .join(" ");
  if (!agentSaid.includes(TURN_1_MARKER)) return { text: TURN_1_TEXT };
  if (!agentSaid.includes(TURN_2_MARKER)) return { text: TURN_2_TEXT };
  return { text: TURN_3_TEXT, action: "hangup" };
}

// Compact system prompt (~30% smaller than M2 version, same behavior).
const SYSTEM_INSTRUCTION = `You are a brief English-speaking voice receptionist for FerroLaser (Chinese laser cutter/engraver manufacturer, US market).

JOB: Qualify the caller in 2-4 turns on: material, thickness (mm), budget (USD), timeline. Then recommend ONE SKU from the provided Catalog with one-clause reason AND promise a sales-expert follow-up before hangup.

RULES:
• ONE sentence per reply, under 30 words.
• ACKNOWLEDGE then ASK. Don't repeat questions already asked (check history).
• CLOSING TURN (the one with action="hangup"): MUST include both (a) the recommended SKU with one-clause reason AND (b) the explicit commitment "a sales expert will reach out to you shortly" (or close paraphrase). Example: "Based on what you described, the STJ1390-2 is a good fit — handles your aluminum at your budget. A sales expert will reach out to you shortly to confirm pricing and lead time."
• Set action="hangup" ONLY after that closing line.
• NEVER invent SKUs. Only from Catalog block.

ASR DRIFT (decode by context):
still→steel, miles→months, weight→week, label/dealer→laser, science shop→sign shop, anode/ollum→aluminum, "one part hundred"→"one hundred parts", "(inaudible)"→ignore, "Pawprint Studio"→ignore (own brand artifact)

WORD NUMBERS: "twenty five thousand"=$25000, "two months"=2 months, "a couple weeks"=2.

OUT-OF-SCOPE: pivot back to qualification briefly. Low budget (<$500): flag floor.

OUTPUT: STRICT JSON {text, action?, extracted?{material,thickness_mm,budget_usd,timeline_weeks}, rationale?}. Raw JSON only — first char {, last char }. No markdown.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    action: { type: "string" },
    extracted: {
      type: "object",
      properties: {
        material: { type: "string" },
        thickness_mm: { type: "number" },
        budget_usd: { type: "number" },
        timeline_weeks: { type: "number" },
      },
    },
    rationale: { type: "string" },
  },
  required: ["text"],
};

// Race Gemini against a hard wall. If Gemini doesn't return within this time,
// we cut losses and stall/FSM — keeping P99 latency bounded.
const GEMINI_HARD_TIMEOUT_MS = 2800;

export async function generateVoiceReply(
  body: Record<string, unknown>,
  env: Bindings
): Promise<Record<string, unknown>> {
  const data = (body.data ?? {}) as Record<string, unknown>;
  const currentMsg = typeof data.transcript === "string" ? data.transcript : "";
  const historyRaw = Array.isArray(body.recentHistory)
    ? (body.recentHistory as Array<Record<string, unknown>>)
    : [];

  // Layer 1: stall guard (sync, no I/O — instant return).
  if (isStallable(currentMsg)) {
    return { text: STALL_TEXT };
  }

  // Layer 2: trim history to last 8 turns, content cap 150 chars each.
  const history = historyRaw.slice(-8).map((m) => ({
    role: String(m?.role ?? m?.direction ?? "?"),
    content: String(m?.content ?? "").slice(0, 150),
  }));

  // Skip Supermemory retrieval on the very first user turn — no agent reply
  // yet means we'll always ask the opener question. Saves ~300ms.
  const agentHasSpoken = history.some(
    (m) => m.role === "agent" || m.role === "outbound"
  );

  let products: ProductMemory[] = [];
  if (agentHasSpoken) {
    try {
      products = await searchProducts(env, currentMsg.slice(0, 300), 3);
    } catch (err) {
      console.warn("[voice-reply] supermemory search failed:", err);
    }
  }

  // Build a compact prompt.
  const transcriptLines = history.map((m) => `${m.role}: ${m.content}`);
  const currentLine = `CURRENT user: ${currentMsg.slice(0, 250)}`;
  const catalogBlock = products.length
    ? "Catalog:\n" +
      products
        .map((p) => `• ${p.sku} — ${p.name} — ${p.content.slice(0, 250)}`)
        .join("\n")
    : "Catalog: (skip — open the conversation by asking material+thickness)";

  const userPrompt = `History:\n${transcriptLines.join("\n")}\n\n${currentLine}\n\n${catalogBlock}\n\nNext reply as JSON.`;

  // Race Gemini against a hard wall.
  const llmPromise = geminiJson(env, {
    systemInstruction: SYSTEM_INSTRUCTION,
    userPrompt,
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: 256,
    temperature: 0.3,
    model: "gemini-2.5-flash",
    timeoutMs: GEMINI_HARD_TIMEOUT_MS,
  });

  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), GEMINI_HARD_TIMEOUT_MS + 100)
  );

  const llm = await Promise.race([llmPromise, timeoutPromise]);

  if (!llm || typeof llm.text !== "string" || llm.text.trim().length === 0) {
    // Soft fallback: stall mid-call, FSM turn 1 if no progress yet.
    const agentSaidStr = history
      .filter((m) => m.role === "agent" || m.role === "outbound")
      .map((m) => m.content)
      .join(" ");
    if (!agentSaidStr.includes(TURN_1_MARKER)) {
      return fsmFallback(history);
    }
    return { text: STALL_TEXT };
  }

  const out: Record<string, unknown> = { text: llm.text };
  if (llm.action === "hangup" || llm.action === "transfer") {
    out.action = llm.action;
  }
  return out;
}
