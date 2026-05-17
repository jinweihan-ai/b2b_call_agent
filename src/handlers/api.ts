import { Hono } from "hono";
import type { Bindings } from "../types";
import {
  listPersons,
  getPerson,
  renamePerson,
  startResearch,
  listCalls,
  getCall,
  sendCustomerSmsAction,
  sendSupplierRfqAction,
  ackBriefingAction,
  moveToQuotedAction,
  moveToNegotiatingAction,
  setOutcomeAction,
  listProducts,
  searchProductsAction,
  reindexLeadsAction,
  type ServiceResult,
} from "../lib/services";

// ─── REST API v1 ──────────────────────────────────────────────────────
//
// Mount in src/index.ts via `app.route("/api/v1", apiApp)`. All routes
// require `X-API-Key: $API_KEY` (matched against env.API_KEY). JSON in,
// JSON out. Errors are returned as `{error: {code, message}}` with the
// service-level HTTP status.
//
// Versioning: this is /api/v1. Breaking changes go in /api/v2. Additive
// changes (new fields) can stay in v1.

const api = new Hono<{ Bindings: Bindings }>();

// X-API-Key middleware. Skip for the discovery root so 401s don't surprise
// integrators trying to figure out what's there.
api.use("*", async (c, next) => {
  if (c.req.path === "/api/v1" || c.req.path === "/api/v1/") return next();
  const provided = c.req.header("x-api-key") ?? c.req.header("X-API-Key");
  const expected = c.env.API_KEY;
  if (!expected) {
    return c.json(
      { error: { code: "server_misconfigured", message: "API_KEY is not configured on the server" } },
      503
    );
  }
  if (!provided || provided !== expected) {
    return c.json(
      { error: { code: "unauthorized", message: "missing or invalid X-API-Key" } },
      401
    );
  }
  return next();
});

function respond<T>(r: ServiceResult<T>): Response {
  if (r.ok) {
    return new Response(JSON.stringify(r.data), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(
    JSON.stringify({ error: { code: r.code, message: r.message } }),
    { status: r.status, headers: { "content-type": "application/json" } }
  );
}

async function readJsonBody(c: { req: { raw: Request } }): Promise<Record<string, unknown> | null> {
  try {
    const text = await c.req.raw.text();
    if (!text) return {};
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Discovery root ──
api.get("/", (c) =>
  c.json({
    name: "b2b-call-agent REST API",
    version: "v1",
    auth: "Required: X-API-Key header. See .dev.vars.example for the env var name.",
    endpoints: [
      { method: "GET",  path: "/api/v1/persons",                       desc: "List all leads (deduped by phone)" },
      { method: "GET",  path: "/api/v1/persons/:phone",                desc: "Lead detail with calls + research" },
      { method: "POST", path: "/api/v1/persons/:phone/rename",         body: { display_name: "string | null" }, desc: "Set or clear customer display name" },
      { method: "POST", path: "/api/v1/persons/:phone/research",       body: {}, desc: "Kick off Browser Use background check" },
      { method: "GET",  path: "/api/v1/calls",                         desc: "List all calls" },
      { method: "GET",  path: "/api/v1/calls/:id",                     desc: "Single call with transcript + entities + drafts" },
      { method: "POST", path: "/api/v1/calls/:id/sms",                 body: { text: "string" }, desc: "Send SMS to caller via Agent Phone" },
      { method: "POST", path: "/api/v1/calls/:id/rfq",                 body: { text: "string" }, desc: "Post RFQ to #sourcing-china Slack" },
      { method: "POST", path: "/api/v1/calls/:id/briefing/ack",        body: {}, desc: "Mark internal briefing as read" },
      { method: "POST", path: "/api/v1/calls/:id/stage",               body: { to: "quoted | negotiating", factory_price_usd: "number?", factory_lead_time_weeks: "number?", sentiment: "positive|negotiating|objecting?", notes: "string?" }, desc: "Transition pipeline stage" },
      { method: "POST", path: "/api/v1/calls/:id/outcome",             body: { outcome: "won | lost | nurture", note: "string?" }, desc: "Close the deal" },
      { method: "GET",  path: "/api/v1/products",                      desc: "Full FerroLaser catalog" },
      { method: "GET",  path: "/api/v1/products/search?q=...",         desc: "Semantic search via Supermemory" },
      { method: "POST", path: "/api/v1/admin/reindex",                 body: {}, desc: "Backfill lead index from existing call records" },
    ],
  })
);

// ── Persons ──
api.get("/persons", async (c) => respond(await listPersons(c.env)));
api.get("/persons/:phone", async (c) => respond(await getPerson(c.env, c.req.param("phone"))));

api.post("/persons/:phone/rename", async (c) => {
  const body = await readJsonBody(c);
  if (body === null) return respond({ ok: false, code: "invalid_json", message: "request body is not valid JSON", status: 400 });
  const dn = body.display_name;
  const displayName =
    dn === null || dn === undefined
      ? null
      : typeof dn === "string"
      ? dn
      : null;
  return respond(await renamePerson(c.env, c.req.param("phone"), displayName));
});

api.post("/persons/:phone/research", async (c) =>
  respond(await startResearch(c.env, c.req.param("phone")))
);

// ── Calls ──
api.get("/calls", async (c) => respond(await listCalls(c.env)));
api.get("/calls/:id", async (c) => respond(await getCall(c.env, c.req.param("id"))));

api.post("/calls/:id/sms", async (c) => {
  const body = await readJsonBody(c);
  if (body === null) return respond({ ok: false, code: "invalid_json", message: "request body is not valid JSON", status: 400 });
  const text = typeof body.text === "string" ? body.text : "";
  return respond(await sendCustomerSmsAction(c.env, c.req.param("id"), text));
});

api.post("/calls/:id/rfq", async (c) => {
  const body = await readJsonBody(c);
  if (body === null) return respond({ ok: false, code: "invalid_json", message: "request body is not valid JSON", status: 400 });
  const text = typeof body.text === "string" ? body.text : "";
  return respond(await sendSupplierRfqAction(c.env, c.req.param("id"), text));
});

api.post("/calls/:id/briefing/ack", async (c) =>
  respond(await ackBriefingAction(c.env, c.req.param("id")))
);

api.post("/calls/:id/stage", async (c) => {
  const body = await readJsonBody(c);
  if (body === null) return respond({ ok: false, code: "invalid_json", message: "request body is not valid JSON", status: 400 });
  const to = typeof body.to === "string" ? body.to : "";
  if (to === "quoted") {
    return respond(
      await moveToQuotedAction(c.env, c.req.param("id"), {
        factory_price_usd: typeof body.factory_price_usd === "number" ? body.factory_price_usd : null,
        factory_lead_time_weeks:
          typeof body.factory_lead_time_weeks === "number" ? body.factory_lead_time_weeks : null,
        notes: typeof body.notes === "string" ? body.notes : null,
      })
    );
  }
  if (to === "negotiating") {
    const s = body.sentiment;
    const sentiment =
      s === "positive" || s === "negotiating" || s === "objecting" ? s : null;
    return respond(
      await moveToNegotiatingAction(c.env, c.req.param("id"), {
        sentiment,
        notes: typeof body.notes === "string" ? body.notes : null,
      })
    );
  }
  return respond({
    ok: false,
    code: "invalid_input",
    message: `to must be 'quoted' or 'negotiating', got ${String(to)}`,
    status: 400,
  });
});

api.post("/calls/:id/outcome", async (c) => {
  const body = await readJsonBody(c);
  if (body === null) return respond({ ok: false, code: "invalid_json", message: "request body is not valid JSON", status: 400 });
  const outcome = body.outcome;
  if (outcome !== "won" && outcome !== "lost" && outcome !== "nurture") {
    return respond({
      ok: false,
      code: "invalid_input",
      message: `outcome must be 'won'|'lost'|'nurture', got ${String(outcome)}`,
      status: 400,
    });
  }
  const note = typeof body.note === "string" ? body.note : null;
  return respond(await setOutcomeAction(c.env, c.req.param("id"), outcome, note));
});

// ── Products ──
api.get("/products", (c) => respond(listProducts()));

api.get("/products/search", async (c) => {
  const q = c.req.query("q") ?? "";
  return respond(await searchProductsAction(c.env, q));
});

// ── Admin ──
api.post("/admin/reindex", async (c) => respond(await reindexLeadsAction(c.env)));

export default api;
