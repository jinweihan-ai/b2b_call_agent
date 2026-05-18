# Devpost submission text — b2b-call-agent

Drafted for **YC Hackathon 2026 — "call my agent" track**. Copy-paste sections into the corresponding Devpost fields. Word counts noted where Devpost imposes a hint.

---

## Tagline (140 char limit)

**First-24h inquiry response for Chinese B2B exporters — AI answers the call, drafts every reply, packages a hand-off for your CRM, in any language.**

---

## Project name

**b2b-call-agent — AI inquiry copilot for Chinese B2B exporters**

---

## Inspiration

China's export manufacturing sector handles a massive volume of overseas inquiries every day. A single transpacific phone call, RFQ email, or LinkedIn message can each be worth $10k-$1M in orders. But three structural pain points cap how many of these inquiries become real revenue:

1. **Timezone mismatch** — buyers in the US, EU, Middle East call when China is asleep. Every missed call is a lead a competitor will pick up first.
2. **English-fluent salespeople are scarce and expensive** — small and mid-size factories can't afford to staff enough native-level English speakers. A single bilingual rep becomes the company's bottleneck.
3. **Multi-language coverage is even more expensive** — global buyers speak Spanish, Arabic, Portuguese, Russian, German, Japanese. Covering them all with humans is prohibitive.

LLMs solve all three structurally: always-on, native-English, natively multilingual. We built b2b-call-agent to turn that capability into a working product.

---

## What it does

When an overseas buyer dials a Chinese factory's number, the AI receptionist picks up, asks the qualification questions a good sales rep would ask (material, thickness, budget, timeline), and recommends a product model with a confidence score. Within seconds of the call ending, the system has:

- Extracted structured lead data from the transcript (Gemini)
- Recommended the best matching SKU from the company's catalog (Supermemory semantic search)
- Drafted three outbound messages: a customer SMS in the caller's language, a Chinese RFQ for the factory's sourcing team, and an internal briefing for the human rep
- Filed the whole call into a CRM (Airtable + Workers KV)
- Pushed a Slack alert to both the sales channel and the China sourcing channel

The human sales rep opens a single URL per customer (`/person/+phone`), sees the entire AI brief plus every prior call's transcript, and clicks "Approve & Send" on the drafts they're happy with. The rep becomes the **AI's copilot**: review, edit, ship.

A separate "Background Check" action sends Browser Use into the wild to research the caller's company — industry, size, recent news, buying signals — and feeds the result back into the workspace.

The system exposes both a REST API (for OA / marketing / KOL platforms to integrate) and an **MCP server** (for AI agents like Claude Desktop to drive the CRM end-to-end), making it composable in larger automation stacks.

---

## How we built it

**Voice path (the hard part — has to feel like a real conversation):**
- Cloudflare Worker (Hono) receives webhooks from Agent Phone (telephony carrier)
- Gemini 2.5 Flash in JSON mode with `thinkingBudget: 0` returns the agent's spoken reply
- ~1.5 second P50 latency, 2.8 second P95 hard cap
- Supermemory grounds every reply with semantic catalog retrieval
- Stall guard handles filler-only utterances; FSM fallback covers timeout cases

**Post-call pipeline:**
- Gemini entity extraction with structured-output schema
- Three drafts generated in a single Gemini call (customer SMS, Chinese supplier RFQ, internal markdown briefing)
- Workers KV: `call_id → CallRecord` (24h TTL) and `lead:<phone> → LeadIndex` (7d TTL)
- Airtable for permanent archive, Slack for human notifications

**Customer workspace UI:**
- Person-centric routing: one URL per real customer, deduped by phone
- Brief card consolidates qualification, recommended SKU, research summary, concerns
- Timeline renders every call from this lead inline with transcript + audio
- Actions column hosts the 3 drafts + research kickoff + CRM stage transitions

**External integrations:**
- REST API at `/api/v1/*` — 14 endpoints, JSON in/out, X-API-Key auth
- MCP server at `/mcp` — 15 tools, 3 static resources, 2 templates; Streamable HTTP / JSON-RPC 2.0
- Both pathways share a single service layer so REST and MCP can never drift from the UI

**Caller background check:**
- Browser Use Cloud v3 (Gemini Flash model under the hood) auto-researches the caller's company
- ~$0.10 per check, 30-90 seconds typical
- Async with lazy-poll on page refresh; live URL exposed so sales can watch the agent in real time

---

## Sponsor integrations

| Sponsor | How we use them |
|---|---|
| **Google DeepMind** | gemini-2.5-flash powers voice replies (~1.5s P50), post-call entity extraction, and the 3-draft generation. JSON mode + `thinkingBudget: 0` keeps latency tight. |
| **Supermemory** | container_tag `ferrolaser-catalog` stores 15 real product memories. Semantic search at ~300ms is the backbone of every Gemini call's grounding. |
| **Browser Use** | Cloud Sessions v3 power the "Background check on caller's company" action — searches the web, visits the homepage, extracts structured company info. Also used pre-hackathon to scrape the FerroLaser product catalog itself. |
| **Agent Phone** | Telephony gateway — inbound voice + outbound SMS + call recording. The whole demo runs off their webhook contract. |

---

## Challenges we ran into

1. **Voice-reply latency** — first version was 3-4 seconds, which feels broken on a phone call. Solved by switching to `thinkingBudget: 0`, capping output at 256 tokens, trimming the system prompt 30%, and skipping Supermemory retrieval on the first turn (no agent reply to ground yet). Final P50 ~1.5s.

2. **Cost overruns on background research** — first iteration used Claude Sonnet 4.6 with all skills enabled. Agent burned through the $0.50 budget cap after 17 steps without completing. Switched to bu-mini (Gemini Flash), `skills: false`, and a tight prompt with a hard 8-step limit. Now ~$0.10 per check, ~9 steps typical, succeeds reliably.

3. **CRM state was conflated with AI task progress** — initial state machine mixed "AI has generated drafts" and "sales rep has actually sent things" into the same axis. Refactored to a proper B2B pipeline (new_lead → outreach_sent → quoted → negotiating → won/lost/nurture) with AI prep status as a sub-indicator.

4. **Call-centric vs customer-centric UI** — first version was a page per call. But a customer often makes multiple calls. Refactored URL routing from `/call/:id` to `/person/:phone`, with calls becoming timeline entries inside the customer workspace. Dashboard cards deduped to one-per-customer.

5. **MCP standardization** — built the MCP server hand-rolled from the JSON-RPC 2.0 spec (no SDK). Implements initialize / tools/list / tools/call / resources/list / resources/read / resources/templates/list. Same X-API-Key auth as the REST API. Tested via curl against `tools/call list_persons` and `resources/read person://+phone`.

---

## Accomplishments

- Voice path latency reliable enough that callers don't notice it's an AI on the first turn
- 15 MCP tools exposed — any Claude Desktop / Cursor / in-house agent can drive the CRM end-to-end
- Full bilingual documentation (English + 中文) with three product screenshots
- Open-source MIT licensed; pushed to GitHub with CI, releases, and Discussions enabled from day one
- Working production deployment on Cloudflare Workers with global edge

---

## What we learned

- **LLMs are structurally better than humans on always-on / multilingual axes** — this isn't a marginal improvement, it's a different product category. Sales reps become curators, not authors.
- **Person-centric data models beat call-centric ones for CRM** — every call is just an event in a longer relationship.
- **Hand-rolled MCP is straightforward** — Streamable HTTP transport with synchronous JSON-RPC is just plain HTTP. No SDK needed.
- **Cost guardrails matter for agentic actions** — Browser Use sessions can burn through budget if you let the model decide when to stop. Hard step caps + cheaper models + tighter prompts cut cost 7x without losing quality.

---

## What's next

**Short term:** Multi-language coverage (Spanish, Arabic, Portuguese), pagination on REST list endpoints, webhook subscriptions for downstream systems, OpenAPI spec auto-generation.

**Mid term:** Multi-tenant isolation (per-factory data + product catalog), HubSpot / Salesforce / Feishu OA bidirectional sync, proactive outbound calls.

**Long term:** Inquiry-attribution + ROI reporting aligned to CPL (Cost Per Lead), agentic follow-up across SMS / email / social channels.

Designed to ship as a standard SaaS. China has tens of thousands of B2B export companies with real inquiry volume; CPL gives a clean price anchor for the value prop.

---

## Built with

`cloudflare-workers` `hono` `typescript` `gemini-2.5-flash` `supermemory` `browser-use` `agent-phone` `airtable` `slack` `mcp` `model-context-protocol` `voice-ai` `b2b-saas` `crm`

---

## Try it out

- 🌐 **Live demo**: https://b2b-call-agent.jinwei-han93.workers.dev
- 📦 **Source**: https://github.com/jinweihan-ai/b2b_call_agent
- 🎬 **Demo video**: (to be added — record a real inbound call)
- 📄 **Release notes**: https://github.com/jinweihan-ai/b2b_call_agent/releases/tag/v0.1.0
- 💬 **Discussion**: https://github.com/jinweihan-ai/b2b_call_agent/discussions/1

---

## Demo script (for the 3-minute video)

**0:00-0:20 · Setup**
> "Chinese B2B factories miss overseas inquiries every night because of time zones, English fluency, and language coverage. We built b2b-call-agent — an LLM-powered AI receptionist that picks up the phone in any language, qualifies the lead, drafts every outbound reply, and hands a sales rep a ready-to-send packet."

**0:20-0:50 · Dashboard**
- Open https://b2b-call-agent.jinwei-han93.workers.dev
- Point at the kanban: "One card per customer. AI prep chips show which outreach actions are sent. Research enrichment from Browser Use shows industry + size inline."

**0:50-1:30 · Real call** *(or replay)*
- Dial the demo number from a phone
- "Watch — the AI is using Gemini 2.5 Flash, ~1.5 second reply latency. It asks about material, thickness, budget, timeline."
- Hang up

**1:30-2:20 · Customer workspace**
- Open the new lead at `/person/+phone`
- Brief card: "AI extracted material, budget, recommended SKU, qualification score 88 — Hot lead."
- Click "Run background check" → "Browser Use spins up an agent that visits the caller's company website, comes back with industry, size, recent news, buying signals."
- 3 drafts: "Customer SMS in English. Chinese RFQ for the factory team. Internal briefing for the salesperson. All editable, all reviewable."
- Click Send → judge's phone gets an SMS in seconds

**2:20-2:50 · MCP / AI integration**
- Open Claude Desktop / Cursor
- Show that the MCP server exposes 13 tools mapped to the REST API
- Ask the agent: "Find me a hot lead in the sign-shop industry and post the supplier RFQ" — watch it call list_persons → get_person → send_rfq

**2:50-3:00 · Close**
> "AI is the autopilot. The human stays accountable. Open source, MIT licensed. github.com/jinweihan-ai/b2b_call_agent."
