// Ember by soybean_alien
// Local tracker: one static page and a small JSON API over SQLite. No dependencies.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4319;
const DATA = path.join(here, "data");
const PHOTOS = path.join(DATA, "photos");
fs.mkdirSync(PHOTOS, { recursive: true });

const db = new DatabaseSync(path.join(DATA, "listings.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, created TEXT, sold_at TEXT, sold_price REAL, data TEXT DEFAULT '{}');
  CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY, item_id INTEGER, file TEXT);
  CREATE TABLE IF NOT EXISTS postings(id INTEGER PRIMARY KEY, item_id INTEGER, platform TEXT DEFAULT '', url TEXT DEFAULT '',
    posted_at TEXT DEFAULT '', status TEXT DEFAULT 'live');
  CREATE TABLE IF NOT EXISTS buyers(id INTEGER PRIMARY KEY, item_id INTEGER, name TEXT DEFAULT '', handle TEXT DEFAULT '', platform TEXT DEFAULT '',
    stage TEXT DEFAULT 'messaged', meet TEXT DEFAULT '', note TEXT DEFAULT '', updated TEXT);
`);

const now = () => new Date().toISOString();
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
// Anything that isn't a plain YYYY-MM-DD date counts as no date rather than NaN days.
const daysSince = (ymd, until = new Date()) => {
  if (!ymd || !isYmd(ymd)) return null;
  const days = Math.floor((until - new Date(ymd + "T00:00:00")) / 864e5);
  return Number.isNaN(days) ? null : Math.max(0, days);
};

// Close-out details used in the wrap-up message. Editable from the desk.
db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT)");
const SETTINGS = { payment: "cash or Apple Pay", area: "", spot: "", local_off: "0" };
const getSettings = () => ({ ...SETTINGS, ...Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value])) });

try { db.exec("ALTER TABLE buyers ADD COLUMN follow_up TEXT DEFAULT ''"); } catch { /* column already there */ }
// Marks the postings a sale ended, so undoing the sale can put exactly those back live.
try { db.exec("ALTER TABLE postings ADD COLUMN ended_by_sale INTEGER DEFAULT 0"); } catch { /* column already there */ }
db.exec("UPDATE buyers SET stage='contacted' WHERE stage='messaged'");

// What each buyer status asks of the seller: whose move it is, what to do, and how many hours after their last move it falls due.
const MOVES = {
  contacted: ["you", "Reply and offer two pickup times", 0],
  asked: ["you", "Answer their question", 0],
  countered: ["you", "Send the calm asking-price reply", 0],
  accepted: ["you", "Send the wrap-up message and set a pickup time", 0],
  thinking: ["them", "Send one friendly check-in", 24],
  silent: ["them", "Send one nudge, then let it go", 24],
  "time set": ["you", "Confirm the pickup with them", 0],
  confirmed: ["them", "Message them an hour before pickup", null],
  bought: ["you", "Send the thank-you and ask for feedback", 48], // two days after the handover
};
const PICKUP = ["time set", "confirmed", "bought", "thanked"];

function moveOf(b) {
  const m = MOVES[b.stage];
  if (!m) return null;
  let due = b.follow_up ? new Date(b.follow_up) : m[2] === null ? null : new Date(new Date(b.updated).getTime() + m[2] * 36e5);
  if (due && isNaN(due)) due = null;
  return { who: m[0], text: m[1], due: due ? due.toISOString() : null, is_due: !!due && due <= new Date() };
}

// The buyer who decides the item's stage: a set pickup wins, otherwise whoever moved last.
function leadBuyer(it) {
  const active = it.buyers.filter((b) => b.stage !== "dropped");
  return active.find((b) => PICKUP.includes(b.stage)) || [...active].sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0] || null;
}

// The stage is worked out from what has been recorded, so nothing has to be moved by hand.
function stageOf(it, lead) {
  if (it.sold_at) return "sold";
  if (lead) return PICKUP.includes(lead.stage) ? "pickup" : MOVES[lead.stage] ? lead.stage : "contacted";
  if (it.postings.some((p) => p.status === "live")) return "listed";
  return "draft";
}

function getItem(id) {
  const row = db.prepare("SELECT * FROM items WHERE id=?").get(id);
  if (!row) return null;
  const it = {
    id: row.id, created: row.created, sold_at: row.sold_at, sold_price: row.sold_price,
    ...JSON.parse(row.data || "{}"),
    photos: db.prepare("SELECT * FROM photos WHERE item_id=? ORDER BY id").all(id),
    postings: db.prepare("SELECT * FROM postings WHERE item_id=? ORDER BY id").all(id),
    buyers: db.prepare("SELECT * FROM buyers WHERE item_id=? ORDER BY id").all(id),
  };
  for (const b of it.buyers) b.move = moveOf(b);
  const lead = leadBuyer(it);
  it.lead_id = lead ? lead.id : null;
  it.stage = stageOf(it, lead);
  const first = it.postings.map((p) => p.posted_at).filter(Boolean).sort()[0] || null;
  it.first_posted = first;
  it.days_listed = first ? daysSince(first, it.sold_at ? new Date(it.sold_at) : new Date()) : null;
  it.quiet = it.stage === "listed" && it.days_listed !== null && it.days_listed >= 3; // listed 3+ days with no messages
  return it;
}

function board() {
  const items = db.prepare("SELECT id FROM items ORDER BY id DESC").all().map((r) => getItem(r.id));
  const open = items.filter((i) => i.stage !== "sold" && i.stage !== "draft");
  const sold = items.filter((i) => i.stage === "sold");
  // Follow-ups that are due now, oldest first. Quiet listings count too: the move is to swap the wording.
  const reminders = [];
  for (const i of items) {
    // After a sale the only follow-up left is the thank-you to the buyer who bought.
    for (const b of i.buyers) if (b.stage !== "dropped" && b.move?.is_due && (i.stage !== "sold" || b.stage === "bought")) reminders.push({ item_id: i.id, item: i.name, buyer: b.name, stage: b.stage, text: b.move.text, due: b.move.due });
    if (i.quiet) reminders.push({ item_id: i.id, item: i.name, buyer: "", stage: "listed", text: `${i.days_listed} days with no messages: swap in the second version`, due: null });
  }
  reminders.sort((a, b) => String(a.due || "9").localeCompare(String(b.due || "9")));
  const soldDays = sold.map((i) => i.days_listed).filter((d) => d !== null);
  const sum = (arr, f) => arr.reduce((t, i) => t + (Number(f(i)) || 0), 0);
  return {
    items,
    reminders,
    settings: getSettings(),
    stats: {
      listed: open.length,
      listed_value: sum(open, (i) => i.asking),
      in_talks: open.filter((i) => i.lead_id).length,
      sold: sold.length,
      sold_value: sum(sold, (i) => i.sold_price),
      at_asking: sold.filter((i) => Number(i.asking) && Number(i.sold_price) >= Number(i.asking)).length,
      avg_days: soldDays.length ? Math.round((soldDays.reduce((a, b) => a + b, 0) / soldDays.length) * 10) / 10 : null,
    },
  };
}

// ---------------------------------------------------------------- http

const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 60e6) throw new Error("Upload too large.");
    chunks.push(c);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };
function serveFile(res, root, rel) {
  const file = path.join(root, path.normalize(rel).replace(/^([/\\]|\.\.)+/, ""));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: "Not found" });
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const itemExists = (id) => !!db.prepare("SELECT 1 FROM items WHERE id=?").get(id);

const ITEM_FIELDS = ["name", "asking", "new_price", "spec_url", "notes", "title", "body", "title2", "body2", "lead", "in_use", "mkt_low", "mkt_mid", "mkt_high", "mkt_checked"];
const POSTING_FIELDS = ["platform", "url", "posted_at", "status"];
const BUYER_FIELDS = ["name", "handle", "platform", "stage", "meet", "note", "follow_up"];
const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => obj[f] !== undefined).map((f) => [f, obj[f]]));

function updateRow(table, id, fields, body, extra = {}) {
  const set = { ...pick(body, fields), ...extra };
  const keys = Object.keys(set);
  if (keys.length) db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`).run(...keys.map((k) => String(set[k] ?? "")), id);
}

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  let r;

  if (p === "/api/board" && m === "GET") return send(res, 200, board());

  if (p === "/api/settings" && m === "PUT") {
    const b = await readBody(req);
    for (const k of Object.keys(SETTINGS)) if (b[k] !== undefined) db.prepare("INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(b[k]));
    return send(res, 200, getSettings());
  }

  if (p === "/api/items" && m === "POST") {
    const info = db.prepare("INSERT INTO items(created, data) VALUES(?,?)").run(now(), JSON.stringify(pick(await readBody(req), ITEM_FIELDS)));
    return send(res, 200, getItem(Number(info.lastInsertRowid)));
  }

  if ((r = p.match(/^\/api\/items\/(\d+)$/))) {
    const id = Number(r[1]);
    const row = db.prepare("SELECT * FROM items WHERE id=?").get(id);
    if (!row) return send(res, 404, { error: "No such item" });
    if (m === "PUT") {
      const b = await readBody(req);
      const data = { ...JSON.parse(row.data || "{}"), ...pick(b, ITEM_FIELDS) };
      db.prepare("UPDATE items SET data=? WHERE id=?").run(JSON.stringify(data), id);
      if (b.sold === true) {
        // A blank price means unknown; 0 is a real price (given away).
        const price = b.sold_price === undefined || b.sold_price === null || String(b.sold_price).trim() === "" ? null : Number(b.sold_price);
        db.prepare("UPDATE items SET sold_at=?, sold_price=? WHERE id=?").run(now(), Number.isFinite(price) ? price : null, id);
        db.prepare("UPDATE postings SET status='ended', ended_by_sale=1 WHERE item_id=? AND status='live'").run(id);
      }
      if (b.sold === false) {
        db.prepare("UPDATE items SET sold_at=NULL, sold_price=NULL WHERE id=?").run(id);
        db.prepare("UPDATE postings SET status='live', ended_by_sale=0 WHERE item_id=? AND ended_by_sale=1").run(id);
      }
      return send(res, 200, getItem(id));
    }
    if (m === "DELETE") {
      for (const ph of db.prepare("SELECT * FROM photos WHERE item_id=?").all(id)) fs.rmSync(path.join(PHOTOS, ph.file), { force: true });
      for (const t of ["photos", "postings", "buyers"]) db.prepare(`DELETE FROM ${t} WHERE item_id=?`).run(id);
      db.prepare("DELETE FROM items WHERE id=?").run(id);
      return send(res, 200, { ok: true });
    }
    return send(res, 200, getItem(id));
  }

  if ((r = p.match(/^\/api\/items\/(\d+)\/photos$/)) && m === "POST") {
    const id = Number(r[1]);
    if (!itemExists(id)) return send(res, 404, { error: "No such item" });
    const photos = (await readBody(req)).photos || [];
    // Photos are stored as .jpg, so only JPEG data URLs are accepted. Check them all before writing any.
    const JPEG = /^data:image\/jpeg;base64,/;
    if (photos.some((d) => !JPEG.test(String(d)))) return send(res, 400, { error: "Photos must be JPEG data URLs." });
    for (const dataUrl of photos) {
      const file = `${id}-${randomUUID()}.jpg`;
      fs.writeFileSync(path.join(PHOTOS, file), Buffer.from(String(dataUrl).replace(JPEG, ""), "base64"));
      db.prepare("INSERT INTO photos(item_id, file) VALUES(?,?)").run(id, file);
    }
    return send(res, 200, getItem(id));
  }
  if ((r = p.match(/^\/api\/photos\/(\d+)$/)) && m === "DELETE") {
    const ph = db.prepare("SELECT * FROM photos WHERE id=?").get(Number(r[1]));
    if (!ph) return send(res, 404, { error: "No such photo" });
    fs.rmSync(path.join(PHOTOS, ph.file), { force: true });
    db.prepare("DELETE FROM photos WHERE id=?").run(ph.id);
    return send(res, 200, getItem(ph.item_id));
  }

  if ((r = p.match(/^\/api\/items\/(\d+)\/postings$/)) && m === "POST") {
    if (!itemExists(Number(r[1]))) return send(res, 404, { error: "No such item" });
    const b = await readBody(req);
    if (b.posted_at && !isYmd(b.posted_at)) return send(res, 400, { error: "posted_at must be YYYY-MM-DD." });
    db.prepare("INSERT INTO postings(item_id, platform, url, posted_at, status) VALUES(?,?,?,?,?)").run(Number(r[1]), b.platform || "", b.url || "", b.posted_at || today(), b.status || "live");
    return send(res, 200, getItem(Number(r[1])));
  }
  if ((r = p.match(/^\/api\/postings\/(\d+)$/))) {
    const row = db.prepare("SELECT * FROM postings WHERE id=?").get(Number(r[1]));
    if (!row) return send(res, 404, { error: "No such posting" });
    if (m === "PUT") {
      const b = await readBody(req);
      if (b.posted_at && !isYmd(b.posted_at)) return send(res, 400, { error: "posted_at must be YYYY-MM-DD." });
      // A status set by hand is the owner's call, so a later "undo sale" leaves it alone.
      updateRow("postings", row.id, POSTING_FIELDS, b, b.status !== undefined ? { ended_by_sale: 0 } : {});
    }
    if (m === "DELETE") db.prepare("DELETE FROM postings WHERE id=?").run(row.id);
    return send(res, 200, getItem(row.item_id));
  }

  if ((r = p.match(/^\/api\/items\/(\d+)\/buyers$/)) && m === "POST") {
    if (!itemExists(Number(r[1]))) return send(res, 404, { error: "No such item" });
    const b = await readBody(req);
    db.prepare("INSERT INTO buyers(item_id, name, handle, platform, stage, meet, note, updated) VALUES(?,?,?,?,?,?,?,?)")
      .run(Number(r[1]), b.name || "", b.handle || "", b.platform || "", b.stage || "contacted", b.meet || "", b.note || "", now());
    return send(res, 200, getItem(Number(r[1])));
  }
  if ((r = p.match(/^\/api\/buyers\/(\d+)$/))) {
    const row = db.prepare("SELECT * FROM buyers WHERE id=?").get(Number(r[1]));
    if (!row) return send(res, 404, { error: "No such buyer" });
    if (m === "PUT") {
      // A change of status is the buyer's (or the seller's) latest move: it restarts the clock and clears any follow-up time set for the old status.
      const b = await readBody(req);
      const moved = b.stage !== undefined && b.stage !== row.stage;
      updateRow("buyers", row.id, BUYER_FIELDS, b, moved ? { updated: now(), follow_up: b.follow_up ?? "" } : {});
    }
    if (m === "DELETE") db.prepare("DELETE FROM buyers WHERE id=?").run(row.id);
    return send(res, 200, getItem(row.item_id));
  }

  return send(res, 404, { error: "Not found" });
}

// Only this machine's own Ember page may use the server. Checking Host stops DNS-rebinding pages from reading
// the board; checking Origin and the JSON content type stops other websites from sending writes.
const OWN_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
function allowed(req, url) {
  if (!OWN_HOSTS.has(String(req.headers.host).toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin && !OWN_HOSTS.has(origin.replace(/^http:\/\//i, "").toLowerCase())) return false;
  if (url.pathname.startsWith("/api/") && req.method !== "GET" && req.method !== "DELETE"
    && !String(req.headers["content-type"]).toLowerCase().startsWith("application/json")) return false;
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (!allowed(req, url)) return send(res, 403, { error: "Forbidden" });
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (url.pathname.startsWith("/photos/")) return serveFile(res, PHOTOS, decodeURIComponent(url.pathname.slice(8)));
    return serveFile(res, path.join(here, "public"), url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: String(err?.message || err) });
  }
});
server.listen(PORT, "127.0.0.1", () => console.log(`Ember is running at http://localhost:${PORT}`));
