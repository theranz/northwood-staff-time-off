// Northwood Staff Time Off — API for the time-off page.
// Each staff member signs in with their email and their own password.
// Passwords are stored only as salted PBKDF2 hashes; sessions are random tokens in an HttpOnly cookie.
// The page itself (public/index.html) is served as a static asset.

const TYPES = ["vacation", "medical", "bereavement", "floating", "other"];
const HOLIDAY_CLASSES = [1, 2, 4]; // Handbook §08.B: paid holidays for Class 1, 2 and 4 only
const STATUSES = ["pending", "approved", "declined"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SESSION_DAYS = 30;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const COOKIE = "nw_session";

// Which days count against time off, by staff classification (0 = Sunday ... 6 = Saturday).
// Class 1–3 (pastoral, full- and part-time): Sunday–Thursday. Fridays and Saturdays never count.
// Class 4–5 (support, temporary): Monday–Thursday. Fridays, Saturdays and Sundays never count.
const WORKDAYS = { pastoral: [0, 1, 2, 3, 4], other: [1, 2, 3, 4] };
const workdaysFor = (cls) => ([1, 2, 3].includes(Number(cls)) ? WORKDAYS.pastoral : WORKDAYS.other);
// freeDays: Map of "YYYY-MM-DD" -> kind ("holiday" | "closed"). Office closures never count for anyone;
// paid holidays don't count for the classes that receive them.
function countDays(start, end, cls, freeDays = new Map()) {
  const days = workdaysFor(cls);
  const getsHolidays = HOLIDAY_CLASSES.includes(Number(cls));
  const [y1, m1, d1] = start.split("-").map(Number);
  const [y2, m2, d2] = end.split("-").map(Number);
  const cur = new Date(Date.UTC(y1, m1 - 1, d1)), last = new Date(Date.UTC(y2, m2 - 1, d2));
  let n = 0;
  for (; cur <= last; cur.setUTCDate(cur.getUTCDate() + 1)) {
    if (!days.includes(cur.getUTCDay())) continue;
    const kind = freeDays.get(cur.toISOString().slice(0, 10));
    if (kind === "closed" || (kind === "holiday" && getsHolidays)) continue;
    n++;
  }
  return n;
}

// ---------- paid holidays + office closures ----------
const ymd = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
function nthWeekday(y, m, wd, n) { const d = new Date(Date.UTC(y, m, 1)); d.setUTCDate(1 + ((wd - d.getUTCDay() + 7) % 7) + 7 * (n - 1)); return d.toISOString().slice(0, 10); }
function lastWeekday(y, m, wd) { const d = new Date(Date.UTC(y, m + 1, 0)); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() - wd + 7) % 7)); return d.toISOString().slice(0, 10); }
function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return new Date(Date.UTC(y, Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1));
}
// Starting holiday dates for a year (Handbook §08.B). Pastors can change or remove any of them on the Holidays tab.
function defaultHolidays(y) {
  const easterMon = easterSunday(y); easterMon.setUTCDate(easterMon.getUTCDate() + 1);
  const tg = nthWeekday(y, 10, 4, 4); const tgFri = new Date(tg + "T00:00:00Z"); tgFri.setUTCDate(tgFri.getUTCDate() + 1);
  return [
    [ymd(y, 0, 1), "New Year's Day"],
    [easterMon.toISOString().slice(0, 10), "Easter (Monday after Easter)"],
    [lastWeekday(y, 4, 1), "Memorial Day"],
    [ymd(y, 6, 4), "Independence Day"],
    [nthWeekday(y, 8, 1, 1), "Labor Day"],
    [tg, "Thanksgiving Day"],
    [tgFri.toISOString().slice(0, 10), "Day after Thanksgiving"],
    [ymd(y, 11, 24), "Christmas Eve"],
    [ymd(y, 11, 25), "Christmas Day"],
  ];
}
async function ensureHolidays(env, years) {
  for (const y of years) {
    const done = await env.DB.prepare("SELECT year FROM holiday_years WHERE year = ?").bind(y).first();
    if (done) continue;
    await env.DB.batch([
      ...defaultHolidays(y).map(([date, name]) => env.DB.prepare("INSERT OR IGNORE INTO free_days (date, name, kind, added_by) VALUES (?,?,'holiday','default')").bind(date, name)),
      env.DB.prepare("INSERT OR IGNORE INTO holiday_years (year) VALUES (?)").bind(y),
    ]);
  }
}
async function freeDayMap(env, start, end) {
  const { results } = await env.DB.prepare("SELECT date, kind FROM free_days WHERE date BETWEEN ? AND ?").bind(start, end).all();
  return new Map(results.map((r) => [r.date, r.kind]));
}
// Recount vacation/medical days on requests that overlap a changed range, so balances stay right
// when a pastor adds or removes a holiday or closure after requests were made.
async function recountRequests(env, start, end) {
  const { results } = await env.DB.prepare(
    "SELECT r.id, r.start, r.end, r.type, s.cls FROM requests r JOIN staff s ON s.id = r.staff_id WHERE r.end >= ? AND r.start <= ? AND r.type != 'floating'"
  ).bind(start, end).all();
  if (!results.length) return;
  const lo = results.reduce((a, r) => (r.start < a ? r.start : a), start), hi = results.reduce((a, r) => (r.end > a ? r.end : a), end);
  const free = await freeDayMap(env, lo, hi);
  await env.DB.batch(results.map((r) => env.DB.prepare("UPDATE requests SET days = ? WHERE id = ?").bind(countDays(r.start, r.end, r.cls, free), r.id)));
}

const json = (data, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
const fail = (message, status = 400) => json({ error: message }, status);
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

// ---------- password + session helpers ----------
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (bytes) => toHex(crypto.getRandomValues(new Uint8Array(bytes)));

async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return toHex(bits);
}
async function sha256(text) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Use at least 8 characters for the password.";
  if (pw.length > 200) return "That password is too long.";
  return null;
}
async function setPassword(env, staffId, password, mustChange) {
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt);
  await env.DB.prepare("UPDATE staff SET pw_hash = ?, pw_salt = ?, must_change = ?, failed_logins = 0, locked_until = NULL WHERE id = ?")
    .bind(hash, salt, mustChange ? 1 : 0, staffId).run();
}
function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return "";
}
const sessionCookie = (token, maxAge) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function whoIsThis(request, env) {
  const token = readCookie(request, COOKIE);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(
    "SELECT s.* FROM sessions x JOIN staff s ON s.id = x.staff_id WHERE x.token_hash = ? AND x.expires_at > ? AND s.active = 1"
  ).bind(await sha256(token), new Date().toISOString()).first();
  if (!row) return null;
  const email = (row.email || "").toLowerCase();
  const admins = (env.ADMIN_EMAILS || "").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  return { email, isAdmin: admins.includes(email), staff: row, tokenHash: await sha256(token) };
}

async function handleAuth(request, env, action) {
  const body = (await (async () => { try { return await request.json(); } catch (e) { return null; } })()) || {};
  if (action === "login") {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const generic = "That email and password don't match. Check them and try again.";
    if (!email || !password) return fail("Enter your email and password.");
    const s = await env.DB.prepare("SELECT * FROM staff WHERE lower(email) = ? AND active = 1").bind(email).first();
    if (!s) return fail(generic, 401);
    if (s.locked_until && s.locked_until > new Date().toISOString())
      return fail(`Too many tries. Wait ${LOCK_MINUTES} minutes, or ask Pastor Randy to reset your password.`, 429);
    if (!s.pw_hash) return fail("Your password hasn't been set up yet. Ask Pastor Randy for a starting password.", 401);
    const ok = sameString(await hashPassword(password, s.pw_salt), s.pw_hash);
    if (!ok) {
      const fails = (s.failed_logins || 0) + 1;
      const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
      await env.DB.prepare("UPDATE staff SET failed_logins = ?, locked_until = ? WHERE id = ?").bind(lock ? 0 : fails, lock, s.id).run();
      return fail(generic, 401);
    }
    const token = randomHex(32);
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE staff SET failed_logins = 0, locked_until = NULL WHERE id = ?").bind(s.id),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date().toISOString()),
      env.DB.prepare("INSERT INTO sessions (token_hash, staff_id, expires_at) VALUES (?,?,?)").bind(await sha256(token), s.id, expires),
    ]);
    return json({ ok: true, mustChange: !!s.must_change }, 200, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) });
  }
  if (action === "logout") {
    const token = readCookie(request, COOKIE);
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
  }
  return null;
}

function cleanStaff(row) {
  return {
    id: row.id, name: row.name, email: row.email || "", cls: row.cls,
    start: row.start || "", priorYears: row.prior_years || 0, active: !!row.active,
    hasPassword: !!row.pw_hash, mustChange: !!row.must_change,
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
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const parts = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
    const [resource, id] = parts;
    const method = request.method;

    // Reject cross-site writes (cookie auth): browsers send Origin on POST/PATCH/DELETE.
    if (method !== "GET") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return fail("Request blocked.", 403);
    }

    try {
      if (resource === "auth" && method === "POST") {
        const res = await handleAuth(request, env, id);
        if (res) return res;
      }

      const me = await whoIsThis(request, env);
      if (!me) return fail("Please sign in.", 401);

      // ---- who am I
      if (resource === "me" && method === "GET") {
        return json({ email: me.email, name: me.staff.name, isAdmin: me.isAdmin, staffId: me.staff.id, mustChange: !!me.staff.must_change });
      }

      // ---- change my own password
      if (resource === "password" && method === "POST") {
        const b = (await readBody(request)) || {};
        if (!sameString(await hashPassword(String(b.current || ""), me.staff.pw_salt), me.staff.pw_hash))
          return fail("Your current password isn't right.", 400);
        const problem = passwordProblem(b.next);
        if (problem) return fail(problem);
        if (b.next === b.current) return fail("Choose a new password that's different from the current one.");
        await setPassword(env, me.staff.id, b.next, false);
        await env.DB.prepare("DELETE FROM sessions WHERE staff_id = ? AND token_hash != ?").bind(me.staff.id, me.tokenHash).run();
        return json({ ok: true });
      }

      if (me.staff.must_change) return fail("Please choose a new password first.", 403);

      // ---- staff list
      if (resource === "staff") {
        if (method === "GET") {
          const { results } = await env.DB.prepare("SELECT * FROM staff ORDER BY name").all();
          return json(results.filter((r) => me.isAdmin || r.active).map(cleanStaff).map((s) => (me.isAdmin ? s : { id: s.id, name: s.name, cls: s.cls, start: s.start, priorYears: s.priorYears, active: s.active })));
        }
        if (!me.isAdmin) return fail("Only pastors can change the staff list.", 403);
        const body = (await readBody(request)) || {};
        if (method === "POST" && !id) {
          const sid = newId();
          await env.DB.prepare("INSERT INTO staff (id,name,email,cls,start,prior_years,active) VALUES (?,?,?,?,?,?,1)")
            .bind(sid, String(body.name || "New staff member").slice(0, 80), body.email ? String(body.email).toLowerCase().slice(0, 120) : null, body.cls ?? null, body.start || "", Number(body.priorYears) || 0)
            .run();
          return json({ id: sid }, 201);
        }
        if (method === "POST" && id && parts[2] === "password") {
          const problem = passwordProblem(body.password);
          if (problem) return fail(problem);
          const target = await env.DB.prepare("SELECT id FROM staff WHERE id = ?").bind(id).first();
          if (!target) return fail("That staff member no longer exists.", 404);
          await setPassword(env, id, body.password, id !== me.staff.id);
          await env.DB.prepare("DELETE FROM sessions WHERE staff_id = ?" + (id === me.staff.id ? " AND token_hash != ?" : ""))
            .bind(...(id === me.staff.id ? [id, me.tokenHash] : [id])).run();
          return json({ ok: true });
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
          if (b.end.slice(0, 4) - b.start.slice(0, 4) > 1) return fail("That date range is too long.");
          const who = await env.DB.prepare("SELECT cls FROM staff WHERE id = ? AND active = 1").bind(staffId).first();
          if (!who) return fail("That staff member isn't on the list.");
          let days;
          if (b.type === "floating") {
            // One floating holiday per calendar year, for the classes that receive paid holidays.
            if (!HOLIDAY_CLASSES.includes(Number(who.cls))) return fail("Floating holidays are for Class 1, 2 and 4 staff.");
            if (b.start !== b.end) return fail("A floating holiday is a single day. Choose the same first and last day.");
            const used = await env.DB.prepare("SELECT id FROM requests WHERE staff_id = ? AND type = 'floating' AND status != 'declined' AND substr(start,1,4) = ?")
              .bind(staffId, b.start.slice(0, 4)).first();
            if (used) return fail("The floating holiday for that year has already been requested.");
            days = 0;
          } else {
            // Days are always counted from the staff member's work week, in whole days, skipping
            // paid holidays and office closures. Nobody can change the count.
            await ensureHolidays(env, [...new Set([+b.start.slice(0, 4), +b.end.slice(0, 4)])]);
            days = countDays(b.start, b.end, who.cls, await freeDayMap(env, b.start, b.end));
          }
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

      // ---- paid holidays + office closures
      if (resource === "freedays") {
        if (method === "GET") {
          const y = Number(url.searchParams.get("year")) || new Date().getUTCFullYear();
          if (y < 2020 || y > 2100) return fail("Choose a year between 2020 and 2100.");
          await ensureHolidays(env, [y - 1, y, y + 1]);
          const { results } = await env.DB.prepare("SELECT date, name, kind FROM free_days WHERE date BETWEEN ? AND ? ORDER BY date")
            .bind(`${y - 1}-01-01`, `${y + 1}-12-31`).all();
          return json(results);
        }
        if (!me.isAdmin) return fail("Only pastors can change holidays and closures.", 403);
        if (method === "POST") {
          const b = (await readBody(request)) || {};
          const end = b.end || b.start;
          if (!DATE.test(b.start || "") || !DATE.test(end)) return fail("Enter the date (or first and last date).");
          if (end < b.start) return fail("The last day comes before the first day.");
          if (!["holiday", "closed"].includes(b.kind)) return fail("Choose paid holiday or office closed.");
          const name = String(b.name || "").trim().slice(0, 80);
          if (!name) return fail("Give it a name, like \"Office closed for VBS\".");
          const dates = [];
          for (const d = new Date(b.start + "T00:00:00Z"); d <= new Date(end + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) dates.push(d.toISOString().slice(0, 10));
          if (dates.length > 31) return fail("Add at most 31 days at a time.");
          await ensureHolidays(env, [...new Set(dates.map((d) => +d.slice(0, 4)))]);
          await env.DB.batch(dates.map((d) => env.DB.prepare("INSERT INTO free_days (date, name, kind, added_by) VALUES (?,?,?,?) ON CONFLICT(date) DO UPDATE SET name = excluded.name, kind = excluded.kind, added_by = excluded.added_by").bind(d, name, b.kind, me.email)));
          await recountRequests(env, b.start, end);
          return json({ ok: true, added: dates.length }, 201);
        }
        if (method === "DELETE" && id && DATE.test(id)) {
          await env.DB.prepare("DELETE FROM free_days WHERE date = ?").bind(id).run();
          await recountRequests(env, id, id);
          return json({ ok: true });
        }
      }

      return fail("Not found.", 404);
    } catch (err) {
      return fail("Something went wrong saving that. Try again in a moment.", 500);
    }
  },
};
