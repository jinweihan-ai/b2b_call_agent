// M2 entity extraction — regex + keyword matching against the transcript.
// Intentionally lenient (handles ASR misspellings like "still"→"steel",
// "miles"→"months", "weight"→"week"). M3 replaces this with an LLM call
// that does proper natural-language understanding.

import productsJson from "../data/products.json";
// Cast through unknown — JSON import is typed as wide arrays, our Product type
// uses tuples. The runtime data is correct; the cast aligns the types.
const products = productsJson as unknown as { products: Product[] };

export interface ExtractedEntities {
  material: string | null; // e.g., "aluminum", "mild_steel"
  thickness_mm: number | null;
  budget_usd: { min: number; max: number } | null;
  timeline_weeks: number | null;
  raw_keywords_found: string[];
}

interface Product {
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

const MATERIAL_PATTERNS: Array<[string, RegExp]> = [
  // (normalized, regex with ASR-noise tolerance)
  ["aluminum", /\b(aluminum|aluminium|alum|alu)\b/i],
  ["mild_steel", /\b(mild\s*steel|carbon\s*steel|steel|still)\b/i], // "still" is ASR drift
  ["stainless_steel", /\b(stainless|stainless\s*steel|ss)\b/i],
  ["brass", /\b(brass)\b/i],
  ["copper", /\b(copper)\b/i],
  ["acrylic", /\b(acrylic|plexiglass|plexi)\b/i],
  ["wood", /\b(wood|plywood|mdf)\b/i],
];

export function extractEntities(transcript: string): ExtractedEntities {
  const text = (transcript || "").toLowerCase();
  const found: string[] = [];

  // Material
  let material: string | null = null;
  for (const [name, re] of MATERIAL_PATTERNS) {
    if (re.test(text)) {
      material = name;
      found.push(name);
      break;
    }
  }

  // Thickness — "6mm", "6 mm", "6-mm", "6 millimeter(s)"
  let thickness_mm: number | null = null;
  const thickMatch = text.match(
    /\b(\d+(?:\.\d+)?)\s*(?:mm|millimeter|millimeters|millimetre|millimetres)\b/
  );
  if (thickMatch) {
    thickness_mm = parseFloat(thickMatch[1]);
    found.push(`${thickness_mm}mm`);
  }

  // Budget — "25k", "$25,000", "25 thousand"
  let budget_usd: { min: number; max: number } | null = null;
  const kMatch = text.match(/\b(\d+)\s*k\b/);
  const dollarMatch = text.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  const thousandMatch = text.match(/\b(\d+)\s*(?:thousand|grand)\b/);
  let budgetNum: number | null = null;
  if (kMatch) budgetNum = parseInt(kMatch[1], 10) * 1000;
  else if (dollarMatch) budgetNum = parseFloat(dollarMatch[1].replace(/,/g, ""));
  else if (thousandMatch) budgetNum = parseInt(thousandMatch[1], 10) * 1000;
  if (budgetNum !== null && budgetNum >= 1000) {
    // Range = ±20% to allow for negotiation framing
    budget_usd = {
      min: Math.round(budgetNum * 0.8),
      max: Math.round(budgetNum * 1.2),
    };
    found.push(`$${budgetNum.toLocaleString()}`);
  }

  // Timeline — "2 months", "8 weeks", "Q3", "next month", "2 miles" (ASR drift)
  let timeline_weeks: number | null = null;
  const monthsMatch = text.match(/\b(\d+)\s*(?:months?|miles?)\b/); // "miles" = ASR drift for "months"
  const weeksMatch = text.match(/\b(\d+)\s*weeks?\b/);
  const yearsMatch = text.match(/\b(\d+)\s*years?\b/);
  if (monthsMatch) {
    timeline_weeks = parseInt(monthsMatch[1], 10) * 4;
    found.push(`${monthsMatch[1]} months`);
  } else if (weeksMatch) {
    timeline_weeks = parseInt(weeksMatch[1], 10);
    found.push(`${weeksMatch[1]} weeks`);
  } else if (yearsMatch) {
    timeline_weeks = parseInt(yearsMatch[1], 10) * 52;
    found.push(`${yearsMatch[1]} years`);
  } else if (/\b(asap|urgent|right away|next month|soon)\b/.test(text)) {
    timeline_weeks = 4;
    found.push("ASAP");
  }

  return { material, thickness_mm, budget_usd, timeline_weeks, raw_keywords_found: found };
}

// Compute a 0-100 qualification score: how many of {material, thickness,
// budget, timeline} we extracted. M3 will replace with LLM-driven scoring
// that considers fit + signal strength + buying authority.
export function qualScore(e: ExtractedEntities): number {
  let n = 0;
  if (e.material) n++;
  if (e.thickness_mm !== null) n++;
  if (e.budget_usd) n++;
  if (e.timeline_weeks !== null) n++;
  return n * 25;
}

// Match against products.json — best-fit by material capability + thickness
// fit + price band. Returns top match or null.
export function matchProduct(e: ExtractedEntities): Product | null {
  const list = products.products;
  if (!e.material) return null;

  // Filter to products that handle the material
  const candidates = list.filter((p) =>
    p.materials.some((m) => m === e.material)
  );
  if (candidates.length === 0) return null;

  // Filter by thickness if specified
  let pool = candidates;
  if (e.thickness_mm !== null) {
    pool = candidates.filter((p) => p.max_steel_thickness_mm >= e.thickness_mm!);
    if (pool.length === 0) pool = candidates; // fall back if too strict
  }

  // Score each: prefer cheapest that meets thickness; if budget known, prefer
  // products whose midprice is within the budget band.
  const budgetMid = e.budget_usd
    ? (e.budget_usd.min + e.budget_usd.max) / 2
    : null;

  pool.sort((a, b) => {
    const aMid = (a.price_usd_range[0] + a.price_usd_range[1]) / 2;
    const bMid = (b.price_usd_range[0] + b.price_usd_range[1]) / 2;
    if (budgetMid !== null) {
      const aDist = Math.abs(aMid - budgetMid);
      const bDist = Math.abs(bMid - budgetMid);
      return aDist - bDist;
    }
    return aMid - bMid;
  });

  return pool[0];
}
