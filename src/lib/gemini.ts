import type { Bindings } from "../types";

// Gemini 2.5 Flash wrapper — used by voice-reply for live conversation +
// (optionally) by call-end for structured entity extraction.
//
// We use JSON mode (responseMimeType: "application/json") for reliable
// machine-parseable output, with an explicit responseSchema so Gemini
// emits exactly the shape we expect.

export interface VoiceReplyJSON {
  text: string;
  action?: "hangup" | "transfer";
  extracted?: {
    material?: string | null;
    thickness_mm?: number | null;
    budget_usd?: number | null;
    timeline_weeks?: number | null;
  };
  rationale?: string; // why this reply, for replay debugging
}

export interface GeminiGenerateOptions {
  systemInstruction: string;
  userPrompt: string;
  responseSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  temperature?: number;
  model?: string; // default gemini-2.5-flash
  timeoutMs?: number; // hard timeout
}

export async function geminiJson(
  env: Bindings,
  opts: GeminiGenerateOptions
): Promise<Record<string, unknown> | null> {
  const key = env.GEMINI_API_KEY;
  if (!key) {
    console.warn("[gemini] no GEMINI_API_KEY — skipping");
    return null;
  }
  const model = opts.model || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(key)}`;

  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    maxOutputTokens: opts.maxOutputTokens ?? 512,
    temperature: opts.temperature ?? 0.4,
    // Disable Gemini 2.5 "thinking" — it eats the output token budget and
    // adds 1-3s of latency. For a voice agent that needs sub-3s responses
    // and just chooses next-line dialog, thinking is overkill.
    thinkingConfig: { thinkingBudget: 0 },
  };
  if (opts.responseSchema) generationConfig.responseSchema = opts.responseSchema;

  const body = {
    system_instruction: { parts: [{ text: opts.systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: opts.userPrompt }] }],
    generationConfig,
  };

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 4000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.warn(`[gemini] ${resp.status}: ${t.slice(0, 300)}`);
      return null;
    }
    const data = (await resp.json()) as Record<string, unknown>;
    // Extract text from the first candidate's first part
    const candidates = (data.candidates as Array<Record<string, unknown>>) || [];
    const first = candidates[0];
    if (!first) return null;
    const content = first.content as Record<string, unknown> | undefined;
    const parts = (content?.parts as Array<Record<string, unknown>>) || [];
    const text = String(parts[0]?.text ?? "");
    if (!text) {
      console.warn("[gemini] empty text in response. candidates:", JSON.stringify(candidates).slice(0, 500));
      return null;
    }
    // Strip markdown code fences + preamble that Gemini sometimes emits even
    // with responseMimeType:application/json. e.g. "Here's the JSON:\n```json\n{...}\n```"
    const cleaned = extractJsonBlob(text);
    if (!cleaned) {
      console.warn("[gemini] no JSON object found, raw:", text.slice(0, 200));
      return null;
    }
    try {
      return JSON.parse(cleaned) as Record<string, unknown>;
    } catch (e) {
      console.warn(
        "[gemini] JSON parse failed:",
        e,
        "raw:",
        text.slice(0, 200),
        "cleaned:",
        cleaned.slice(0, 200)
      );
      return null;
    }
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      console.warn(`[gemini] timeout after ${timeoutMs}ms`);
    } else {
      console.warn("[gemini] request failed:", err);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Find a JSON object/array in a string, stripping markdown code fences and
// any chatty preamble Gemini may have added.
function extractJsonBlob(raw: string): string | null {
  if (!raw) return null;
  let s = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences
  const fence = s.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/m);
  if (fence) {
    s = fence[1].trim();
  } else {
    // Inline fence anywhere in the text
    const inline = s.match(/```(?:json|JSON)?\s*([\s\S]*?)\s*```/);
    if (inline) s = inline[1].trim();
  }
  // If still has prose preamble, locate the first { ... } object span.
  if (!s.startsWith("{") && !s.startsWith("[")) {
    const start = s.indexOf("{");
    const arrStart = s.indexOf("[");
    const firstBrace =
      start === -1 ? arrStart : arrStart === -1 ? start : Math.min(start, arrStart);
    if (firstBrace >= 0) s = s.slice(firstBrace);
  }
  // Trim trailing prose after the last closing brace.
  const lastClose = Math.max(s.lastIndexOf("}"), s.lastIndexOf("]"));
  if (lastClose >= 0) s = s.slice(0, lastClose + 1);
  return s || null;
}
