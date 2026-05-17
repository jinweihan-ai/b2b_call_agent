import type { Bindings } from "../types";

// Minimal Slack Incoming Webhook poster. Plain text only in M1 — Block Kit
// formatting can land in M2 alongside the replay-page URL.
//
// Docs: https://api.slack.com/messaging/webhooks
export async function postSlackMessage(
  env: Bindings,
  text: string
): Promise<void> {
  if (!env.SLACK_WEBHOOK_URL) {
    console.warn("[slack] missing SLACK_WEBHOOK_URL — skipping post");
    return;
  }

  const res = await fetch(env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "(no body)");
    throw new Error(`Slack ${res.status} ${res.statusText}: ${body}`);
  }
}
