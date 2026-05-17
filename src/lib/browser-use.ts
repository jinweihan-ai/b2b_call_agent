import type { Bindings } from "../types";

// Browser Use Cloud v3 wrapper for the "background check on the caller's
// company" action. The agent runs in the cloud (~30s-3min) and returns
// structured JSON conforming to ResearchOutputSchema. We dispatch async,
// store the session_id, and lazy-poll on subsequent page loads.
//
// Auth: X-Browser-Use-API-Key header. Keys start with bu_.
// Docs: https://docs.browser-use.com/cloud/api-reference

const BU_API_BASE = "https://api.browser-use.com/api/v3";

// BuAgentSessionStatus enum from the OpenAPI spec.
export type BuSessionStatus =
  | "created"
  | "idle"
  | "running"
  | "stopped"
  | "timed_out"
  | "error";

export interface BuSessionResponse {
  id: string;
  status: BuSessionStatus;
  output?: unknown; // ResearchOutput when output_schema is set
  isTaskSuccessful?: boolean | null;
  liveUrl?: string | null;
  lastStepSummary?: string | null;
  totalCostUsd?: string;
  title?: string | null;
}

// Structured output we ask Browser Use to fill in. JSON Schema below.
export interface ResearchOutput {
  company_name: string | null;
  industry: string | null;
  size: string | null;
  website: string | null;
  recent_news: string | null;
  buying_signals: string | null;
  notes: string | null;
}

const RESEARCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    company_name: {
      type: ["string", "null"],
      description: "Official business name. Null if it can't be identified.",
    },
    industry: {
      type: ["string", "null"],
      description: "Industry / what they do (e.g. 'sign shop', 'monument & headstone fabrication').",
    },
    size: {
      type: ["string", "null"],
      description: "Approximate employee count or company size signal (e.g. '5-10 employees', 'solo operator', 'mid-size').",
    },
    website: {
      type: ["string", "null"],
      description: "Official company website if you found one.",
    },
    recent_news: {
      type: ["string", "null"],
      description: "1-3 sentence summary of recent activity, press, hires, or product launches.",
    },
    buying_signals: {
      type: ["string", "null"],
      description: "Evidence they're actively shopping for laser cutters / engravers / metal fabrication equipment (e.g. job postings mentioning new shop floor, recent investment announcements).",
    },
    notes: {
      type: ["string", "null"],
      description: "Anything else relevant for a sales rep — risks, alternative suppliers they mention, useful context.",
    },
  },
  required: ["company_name"],
} as const;

export interface ResearchTaskInput {
  phone: string;                     // E.164 ideally
  caller_name?: string | null;       // from extracted entities
  caller_company?: string | null;    // from extracted entities
  application?: string | null;       // what they want to cut (e.g. "signs", "aluminum brackets")
  material?: string | null;
  budget_usd?: number | null;
}

function buildPrompt(input: ResearchTaskInput): string {
  const bits: string[] = [];
  bits.push(
    "Research an inbound sales lead for FerroLaser (B2B laser cutter manufacturer, $10k-$50k machines, sells to US small businesses)."
  );
  bits.push("");
  bits.push("Lead from inbound call:");
  bits.push(`- Phone: ${input.phone}`);
  if (input.caller_name) bits.push(`- Name: ${input.caller_name}`);
  if (input.caller_company) bits.push(`- Company: ${input.caller_company}`);
  if (input.application) bits.push(`- Application: ${input.application}`);
  if (input.material) bits.push(`- Material: ${input.material}`);
  if (input.budget_usd) bits.push(`- Budget: $${input.budget_usd.toLocaleString()}`);
  bits.push("");
  bits.push("HARD STEP LIMIT: 8 steps maximum. Then return whatever you have.");
  bits.push("");
  bits.push("Plan:");
  bits.push("1. ONE Google search using the most identifying terms — name+company, or company+city, or the phone number.");
  bits.push("2. Open the most-likely match (usually their official site or LinkedIn).");
  bits.push("3. Skim the homepage / about page for industry + size signals.");
  bits.push("4. Optionally: ONE more search for recent news if time allows.");
  bits.push("5. Return the structured output. Each field 1-2 sentences max.");
  bits.push("");
  bits.push("DO NOT: try to run Python code, parse complex pages programmatically, or visit more than 3 pages. If you can't identify them in 2 searches, return company_name=null with whatever notes you gathered.");
  return bits.join("\n");
}

// Kick off a research task. Returns the new session_id on success.
export async function createResearchTask(
  env: Bindings,
  input: ResearchTaskInput
): Promise<{ ok: true; session_id: string; live_url?: string | null } | { ok: false; error: string }> {
  if (!env.BROWSER_USE_API_KEY) {
    return { ok: false, error: "BROWSER_USE_API_KEY not set" };
  }

  const body = {
    task: buildPrompt(input),
    // gemini-3-flash (bu-mini) — fast + cheap. Sonnet ran us $0.66 because
    // it kept trying Python-level extraction; this task is "search + read",
    // not reasoning. Flash hits ~$0.10-0.15/run typical.
    model: "bu-mini",
    // Hard cost cap — even at cheaper model leaves headroom for retries.
    // ~$96 of $100 credit available; even at $1/task that's 96 checks.
    maxCostUsd: 1.0,
    // Don't keep the session alive after the task ends — one-shot research.
    keepAlive: false,
    outputSchema: RESEARCH_OUTPUT_SCHEMA,
    // Disable Sheets/file integrations — pure browsing is faster + fewer steps.
    skills: false,
    // Faster, no recording needed.
    enableRecording: false,
    // No temporary email needed for company research.
    agentmail: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(`${BU_API_BASE}/sessions`, {
      method: "POST",
      headers: {
        "X-Browser-Use-API-Key": env.BROWSER_USE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return { ok: false, error: `${resp.status}: ${t.slice(0, 400)}` };
    }
    const j = (await resp.json()) as BuSessionResponse;
    return { ok: true, session_id: j.id, live_url: j.liveUrl ?? null };
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    return { ok: false, error: e.name === "AbortError" ? "Browser Use API timed out (>10s)" : e.message };
  }
}

// Poll a research task. Returns the session response on success — caller maps
// status to our 3 states and reads output if completed.
export async function getResearchTask(
  env: Bindings,
  sessionId: string
): Promise<{ ok: true; session: BuSessionResponse } | { ok: false; error: string }> {
  if (!env.BROWSER_USE_API_KEY) {
    return { ok: false, error: "BROWSER_USE_API_KEY not set" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(`${BU_API_BASE}/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { "X-Browser-Use-API-Key": env.BROWSER_USE_API_KEY },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return { ok: false, error: `${resp.status}: ${t.slice(0, 400)}` };
    }
    const session = (await resp.json()) as BuSessionResponse;
    return { ok: true, session };
  } catch (err) {
    clearTimeout(timer);
    const e = err as Error;
    return { ok: false, error: e.name === "AbortError" ? "Browser Use poll timed out (>5s)" : e.message };
  }
}

// Map BU's 6 statuses to our 3 lifecycle states.
//   created/idle/running → "pending"
//   stopped              → "done"  (then check isTaskSuccessful)
//   timed_out/error      → "failed"
export function classifyStatus(
  status: BuSessionStatus
): "pending" | "done" | "failed" {
  if (status === "stopped") return "done";
  if (status === "timed_out" || status === "error") return "failed";
  return "pending";
}

// Pull a ResearchOutput out of BU's `output` field, which is either a string
// (free-form), an object matching our outputSchema, or null. Best-effort —
// any field can be null/missing.
export function parseResearchOutput(raw: unknown): ResearchOutput | null {
  if (raw === null || raw === undefined) return null;

  // Sometimes Browser Use returns the structured object directly; other
  // times it nests under .output or returns a JSON string.
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    // Strip ```json fences if present, then try to parse.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      // Free-form string — wrap into `notes` so the UI still has something.
      return {
        company_name: null,
        industry: null,
        size: null,
        website: null,
        recent_news: null,
        buying_signals: null,
        notes: raw.slice(0, 2000),
      };
    }
  } else if (typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  }
  if (!obj) return null;

  const pickStr = (k: string): string | null => {
    const v = obj![k];
    return typeof v === "string" && v.length > 0 ? v : null;
  };
  return {
    company_name: pickStr("company_name"),
    industry: pickStr("industry"),
    size: pickStr("size"),
    website: pickStr("website"),
    recent_news: pickStr("recent_news"),
    buying_signals: pickStr("buying_signals"),
    notes: pickStr("notes"),
  };
}
