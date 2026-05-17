import type { Bindings } from "../types";
import type { CallRecord } from "../lib/render";
import { appendCallToLead, normalizePhone } from "../lib/leads";

// GET /admin/reindex
//
// One-shot backfill: scans every call_id key in KV (skipping `lead:` keys)
// and re-appends to the lead index keyed by normalized phone. Idempotent —
// running it twice yields the same final state because `appendCallToLead`
// dedupes by call_id.
//
// Returns a small text/plain report so the user can spot-check.
export async function handleReindex(env: Bindings): Promise<Response> {
  const lines: string[] = [];
  let scanned = 0;
  let indexed = 0;
  let skippedNoPhone = 0;
  let skippedLead = 0;
  let cursor: string | undefined = undefined;

  try {
    // Paginate through KV — `list` returns up to 1000 keys per call. Hackathon
    // KV won't be anywhere near that, but loop for safety.
    do {
      const listing: { keys: { name: string }[]; list_complete: boolean; cursor?: string } =
        await env.CALLS.list({ limit: 1000, cursor });
      for (const k of listing.keys) {
        scanned++;
        if (k.name.startsWith("lead:")) {
          skippedLead++;
          continue;
        }
        const raw = await env.CALLS.get(k.name);
        if (!raw) continue;
        let rec: CallRecord;
        try {
          rec = JSON.parse(raw) as CallRecord;
        } catch {
          lines.push(`SKIP malformed: ${k.name}`);
          continue;
        }
        const d = (rec.payload?.data ?? rec.payload ?? {}) as Record<string, unknown>;
        const phoneRaw =
          (typeof d.from === "string" ? d.from : null) ??
          (typeof d.caller_phone === "string" ? (d.caller_phone as string) : null);
        const norm = normalizePhone(phoneRaw);
        if (!norm) {
          skippedNoPhone++;
          continue;
        }
        await appendCallToLead(env, norm, rec.call_id, rec.received_at);
        indexed++;
        lines.push(`OK ${rec.call_id} -> ${norm}`);
      }
      cursor = listing.list_complete ? undefined : listing.cursor;
    } while (cursor);
  } catch (err) {
    lines.push(`ERROR: ${(err as Error).message}`);
  }

  const summary = [
    `Lead index reindex complete`,
    `  scanned:         ${scanned}`,
    `  indexed:         ${indexed}`,
    `  skipped (lead:): ${skippedLead}`,
    `  skipped (no phone): ${skippedNoPhone}`,
    ``,
    ...lines,
  ].join("\n");

  return new Response(summary, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
