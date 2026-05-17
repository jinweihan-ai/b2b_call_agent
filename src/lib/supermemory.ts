import type { Bindings } from "../types";

// Supermemory v3 search wrapper.
// Returns top-N product memories ranked by semantic similarity to `query`.
// Container-scoped to "ferrolaser-catalog" so caller memory (M3+) doesn't
// pollute product retrieval.

export interface ProductMemory {
  sku: string;
  name: string;
  content: string;
  score: number;
  laser_type?: string;
  power_w?: number;
  max_steel_thickness_mm?: number;
  price_min_usd?: number;
  price_max_usd?: number;
  lead_time_weeks?: number;
}

export async function searchProducts(
  env: Bindings,
  query: string,
  limit = 3
): Promise<ProductMemory[]> {
  const key = env.SUPERMEMORY_API_KEY;
  if (!key) {
    console.warn("[supermemory] no SUPERMEMORY_API_KEY — skipping retrieval");
    return [];
  }
  const trimmed = (query || "").trim();
  if (!trimmed) return [];

  const url = "https://api.supermemory.ai/v3/search";
  const body = {
    q: trimmed,
    containerTags: ["ferrolaser-catalog"],
    limit,
  };

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.warn(`[supermemory] search ${resp.status}: ${t.slice(0, 200)}`);
      return [];
    }
    const data = (await resp.json()) as Record<string, unknown>;
    const results = (data.results as Array<Record<string, unknown>>) || [];

    return results.map((r) => {
      const md = (r.metadata as Record<string, unknown>) || {};
      const content = String(r.content ?? "");
      return {
        sku: String(md.sku ?? ""),
        name: String(md.name ?? ""),
        content,
        score: typeof r.score === "number" ? r.score : 0,
        laser_type: md.laser_type as string | undefined,
        power_w: md.power_w as number | undefined,
        max_steel_thickness_mm: md.max_steel_thickness_mm as number | undefined,
        price_min_usd: md.price_min_usd as number | undefined,
        price_max_usd: md.price_max_usd as number | undefined,
        lead_time_weeks: md.lead_time_weeks as number | undefined,
      };
    });
  } catch (err) {
    console.warn("[supermemory] search failed:", err);
    return [];
  }
}
