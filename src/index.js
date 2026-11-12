// Northwood Staff Time Off — API for the time-off page.
// Cloudflare Access sits in front of this Worker and signs people in with their
// @northwoodbaptist.com email. The page itself (public/index.html) is served as a static asset.

const TYPES = ["vacation", "medical", "bereavement", "other"];
const STATUSES = ["pending", "approved", "declined"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const fail = (message, status = 400) => json({ error: message }, status);
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

async function whoIsThis(request, env, ctx) {
  // ctx.access exists only when Cloudflare Access checked the request.
  if (!ctx.access) return null;
  let email = "";
  try {
    const identity = await ctx.access.getIdentity();
    email = identity?.email || "";
  } catch (e) {}
  if (!email) email = request.headers.get("cf-access-authenticated-user-email") || "";
  email = email.trim().toLowerCase();
  if (!email) return null;
  const admins = (env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  const staff = await env.DB.prepare("SELECT * FROM staff WHERE lower(email) = ? AND active = 1").bind(email).first();
  return { email, isAdmin: admins.includes(email), staff: staff || null };
}

function cleanStaff(row) {
  return {
    id: row.id, name: row.name, email: row.email || "", cls: row.cls,
    start: row.start || "", priorYears: row.prior_years || 0, active: !!row.active,
  };
}

function cleanRequest(row, me) {
  const mine = me.staff && row.staff_id === me.staff.id;
  const base = { id: row.id, staffId: row.staff_id, start: row.start, end: row.end, status: row.status };
  if (me.isAdmin || mine) {
    return { ...base, type: row.type, days: row.days, note: row.note || "", createdAt: row.created_at, decidedAt: row.decided_at, decidedBy: row.decided_by };
  }
  // Other staff only see that someone is away, not why.
  return { ...base, type: "away" };
}

async function readBody(request) {
  try { return await request.json(); } catch (e) { return null; }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const me = await whoIsThis(request, env, ctx);
    if (!me) return fail("Please sign in with your Northwood email.", 401);
    if (!me.staff && !me.isAdmin) return fail(`${me.email} isn't on the staff list yet. Ask Pastor Randy to add you.`, 403);

    const parts = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
    const [resource, id] = parts;
    const method = request.method;

    try {
      // ---- who am I
      if (resource === "me" && method === "GET") {
        return json({ email: me.email, isAdmin: me.isAdmin, staffId: me.staff?.id || null });
      }

      // ---- staff list
      if (resource === "staff") {
        if (method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM staff ORDER BY name").all();
          return json(results.filter((r) => me.isAdmin || r.active).map(cleanStaff).map((s) => (me.isAdmin ? s : { id: s.id, name: s.name, cls: s.cls, start: s.start, priorYears: s.priorYears, active: s.active })));
        }
        if (!me.isAdmin) return fail("Only pastors can change the staff list.", 403);
        const body = (await readBody(request)) || {};
        if (method === "POST") {
          const sid = newId();
          await env.DB.prepare("INSERT INTO staff (id,name,email,cls,start,prior_years,active) VALUES (?,?,?,?,?,?,1)")
            .bind(sid, String(body.name || "New staff member").slice(0, 80), body.email ? String(body.email).toLowerCase().slice(0, 120) : null, body.cls ?? null, body.start || "", Number(body.priorYears) || 0)
            .run();
          return json({ id: sid }, 201);
        }
        if (method === "PATCH" && id) {
          const map = { name: "name", email: "email", cls: "cls", start: "start", priorYears: "prior_years", active: "active" };
          const sets = [], vals = [];
          for (const [k, col] of Object.entries(map)) {
            if (!(k in body)) continue;
            let v = body[k];
            if (k === "cls") v = v === null || v === "" ? null : Number(v);
            if (k === "priorYears") v = Number(v) || 0;
            if (k === "active") v = v ? 1 : 0;
            if (k === "email") v = v ? String(v).trim().toLowerCase() : null;
            if (k === "start" && v && !DATE.test(v)) return fail("Start date must be a date.");
            if (k === "cls" && v !== null && ![1, 2, 3, 4, 5].includes(v)) return fail("Class must be 1 through 5.");
            sets.push(`${col} = ?`); vals.push(v);
          }
          if (!sets.length) return fail("Nothing to change.");
          await env.DB.prepare(`UPDATE staff SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
          return json({ ok: true });
        }
      }

      // ---- time-off requests
      if (resource === "requests") {
        if (method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM requests WHERE status != 'declined' OR staff_id = ? OR ? = 1 ORDER BY start")
            .bind(me.staff?.id || "", me.isAdmin ? 1 : 0).all();
          return json(results.map((r) => cleanRequest(r, me)));
        }
        if (method === "POST") {
          const b = (await readBody(request)) || {};
          const staffId = me.isAdmin && b.staffId ? b.staffId : me.staff?.id;
          if (!staffId) return fail("Choose who this request is for.");
          if (!TYPES.includes(b.type)) return fail("Choose a type of time off.");
          if (!DATE.test(b.start || "") || !DATE.test(b.end || "")) return fail("Enter a first and last day.");
          if (b.end < b.start) return fail("The last day off comes before the first day.");
          const days = Number(b.days);
          if (!(days > 0 && days <= 60)) return fail("Enter how many workdays this uses.");
          const rid = newId();
          await env.DB.prepare("INSERT INTO requests (id,staff_id,type,start,end,days,note,status,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)")
            .bind(rid, staffId, b.type, b.start, b.end, days, String(b.note || "").slice(0, 500), new Date().toISOString())
            .run();
          return json({ id: rid }, 201);
        }
        if (id) {
          const row = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first();
          if (!row) return fail("That request no longer exists.", 404);
          const mine = me.staff && row.staff_id === me.staff.id;
          if (method === "DELETE") {
            if (!me.isAdmin && !(mine && row.status === "pending")) return fail("Only pending requests can be withdrawn.", 403);
            await env.DB.prepare("DELETE FROM requests WHERE id = ?").bind(id).run();
            return json({ ok: true });
          }
          if (method === "PATCH") {
            if (!me.isAdmin) return fail("Only pastors can approve requests.", 403);
            const b = (await readBody(request)) || {};
            if (!STATUSES.includes(b.status)) return fail("Unknown status.");
            const decided = b.status === "pending" ? null : new Date().toISOString();
            await env.DB.prepare("UPDATE requests SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?")
              .bind(b.status, decided, decided ? me.email : null, id).run();
            return json({ ok: true });
          }
        }
      }

      return fail("Not found.", 404);
    } catch (err) {
      return fail("Something went wrong saving that. Try again in a moment.", 500);
    }
  },
};
