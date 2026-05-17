import type { Bindings } from "../types";

// Minimal Airtable REST client. We deliberately do NOT use the official
// `airtable` npm package — it relies on dynamic imports and Node-only APIs
// that don't work cleanly on Cloudflare Workers. Raw fetch is enough.
//
// Docs: https://airtable.com/developers/web/api/create-records
export async function writeAirtableRow(
  env: Bindings,
  fields: Record<string, unknown>
): Promise<void> {
  if (!env.AIRTABLE_TOKEN || !env.AIRTABLE_BASE_ID || !env.AIRTABLE_TABLE_NAME) {
    console.warn(
      "[airtable] missing config (AIRTABLE_TOKEN / AIRTABLE_BASE_ID / AIRTABLE_TABLE_NAME) — skipping write"
    );
    return;
  }

  const url = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${encodeURIComponent(
    env.AIRTABLE_TABLE_NAME
  )}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      records: [{ fields }],
      // typecast=true lets Airtable coerce values into single-line / number /
      // date columns even when we send strings — helpful for M1 where we
      // don't yet know exact column types.
      typecast: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Airtable ${res.status} ${res.statusText}: ${body}`);
  }
}
