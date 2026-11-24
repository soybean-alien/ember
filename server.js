// Ember by soybean_alien
// Local tracker: one static page and a small JSON API over SQLite. No dependencies.
//
//   node server.js                 start Ember
//   node server.js --check         exit 0 if Ember is already running, 1 if the port is free, 2 if something else holds it
//   node server.js --restore       list the backups;  --restore <name>  put one back (Ember must be stopped)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8").replace(/^﻿/, "")).version;
const PORT = Number(process.env.PORT) || 4319;
const DATA = process.env.EMBER_DATA ? path.resolve(process.env.EMBER_DATA) : path.join(here, "data");
const PHOTOS = path.join(DATA, "photos");
const BACKUPS = path.join(DATA, "backups");
const DB_FILE = path.join(DATA, "listings.db");

// node:sqlite works without a flag from Node 22.13 (and 23.4). Older versions need --experimental-sqlite, which the launchers don't pass.
export const MIN_NODE = "22.13.0";
export function nodeSupported(v = process.versions.node) {
  const [a, b] = String(v).split(".").map(Number);
  return a > 23 || (a === 23 && b >= 4) || (a === 22 && b >= 13);
}

// ---------------------------------------------------------------- settings, regions, money

// Region decides the date format and which eBay site the research links open. Currency is set on its own,
// and every item keeps the currency it was priced in: nothing is ever converted.
export const REGIONS = {
  US: { label: "United States", locale: "en-US", ebay: "www.ebay.com", currency: "USD" },
  UK: { label: "United Kingdom", locale: "en-GB", ebay: "www.ebay.co.uk", currency: "GBP" },
  IE: { label: "Ireland", locale: "en-IE", ebay: "www.ebay.ie", currency: "EUR" },
  DE: { label: "Germany", locale: "de-DE", ebay: "www.ebay.de", currency: "EUR" },
};
export const CURRENCIES = ["GBP", "USD", "EUR"];
const SETTINGS = { payment: "cash or Apple Pay", area: "", spot: "", local_off: "0", region: "US", currency: "USD", remind_mins: "60" };

// ---------------------------------------------------------------- dates

const now = () => new Date().toISOString();
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));
const isDateTime = (s) => !isNaN(new Date(String(s)));
// Anything that isn't a plain YYYY-MM-DD date counts as no date rather than NaN days.
const daysSince = (ymd, until = new Date()) => {
  if (!ymd || !isYmd(ymd)) return null;
  const days = Math.floor((until - new Date(ymd + "T00:00:00")) / 864e5);
  return Number.isNaN(days) ? null : Math.max(0, days);
};

// ---------------------------------------------------------------- moves

// What each buyer status asks of the seller: whose move it is, what to do, and how many hours after their last move it falls due.
export const MOVES = {
  contacted: ["you", "Reply and offer two pickup times", 0],
  asked: ["you", "Answer their question", 0],
  countered: ["you", "Send the calm asking-price reply", 0],
  accepted: ["you", "Send the wrap-up message and set a pickup time", 0],
  thinking: ["them", "Send one friendly check-in", 24],
  silent: ["them", "Send one nudge, then let it go", 24],
  "time set": ["you", "Confirm the pickup with them", 0],
  confirmed: ["them", "Message them before pickup", null],
  bought: ["you", "Send the thank-you and ask for feedback", 48], // two days after the handover
};
export const BUYER_STAGES = [...Object.keys(MOVES), "thanked", "dropped"];
const PICKUP = ["time set", "confirmed", "bought", "thanked"];

// The move a buyer's status asks for, and when it falls due. A confirmed pickup with a time falls due the set number of minutes
// before it, and if the time passes with no handover recorded it asks for one. The key changes whenever the move or its time
// does, so a reminder marked done comes back only for a new move or a rescheduled pickup.
export function moveOf(b, settings = SETTINGS, at = new Date()) {
  const m = MOVES[b.stage];
  if (!m) return null;
  let text = m[1];
  let due = null;
  const pickup = b.pickup_at && isDateTime(b.pickup_at) ? new Date(b.pickup_at) : null;
  if (b.follow_up && isDateTime(b.follow_up)) due = new Date(b.follow_up);
  else if (b.stage === "confirmed" && pickup) {
    const mins = Math.max(0, Number(settings.remind_mins ?? 60) || 0);
    if (pickup <= at) { text = "Pickup time has passed: record the handover, or reschedule"; due = pickup; }
    else due = new Date(pickup.getTime() - mins * 6e4);
  } else if (m[2] !== null) due = new Date(new Date(b.updated).getTime() + m[2] * 36e5);
  if (due && isNaN(due)) due = null;
  const key = `${b.stage}|${b.updated}|${b.follow_up || ""}|${b.pickup_at || ""}|${text === m[1] ? "" : "late"}`;
  return { who: m[0], text, due: due ? due.toISOString() : null, is_due: !!due && due <= at, key };
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

// ---------------------------------------------------------------- database, migrations and backups

let db;

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");

// A backup is a folder holding a consistent copy of the database and the photos.
export function backup(reason) {
  // Two backups in the same second (a restore straight after an upgrade) get a number rather than colliding.
  let dir = path.join(BACKUPS, `${stamp()}-${reason}`);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(BACKUPS, `${stamp()}-${reason}-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  db.exec(`VACUUM INTO '${path.join(dir, "listings.db").replace(/'/g, "''")}'`);
  if (fs.existsSync(PHOTOS)) fs.cpSync(PHOTOS, path.join(dir, "photos"), { recursive: true });
  return path.basename(dir);
}
// Daily backups: one a day at start-up, keeping the newest ten. Backups made before a migration or a restore are kept.
function dailyBackup() {
  const daily = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((n) => n.endsWith("-daily")).sort() : [];
  if (daily.some((n) => n.startsWith(stamp().slice(0, 8)))) return;
  daily.push(backup("daily"));
  for (const old of daily.slice(0, -10)) fs.rmSync(path.join(BACKUPS, old), { recursive: true, force: true });
}

const addColumn = (table, col) => { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch { /* column already there */ } };

// Numbered migrations; PRAGMA user_version records how many have run. Version 0.1.0 databases had no number but
// already had everything in migration 1, so migration 1 is written to be safe on them.
const MIGRATIONS = [
  () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, created TEXT, sold_at TEXT, sold_price REAL, data TEXT DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS photos(id INTEGER PRIMARY KEY, item_id INTEGER, file TEXT);
      CREATE TABLE IF NOT EXISTS postings(id INTEGER PRIMARY KEY, item_id INTEGER, platform TEXT DEFAULT '', url TEXT DEFAULT '',
        posted_at TEXT DEFAULT '', status TEXT DEFAULT 'live');
      CREATE TABLE IF NOT EXISTS buyers(id INTEGER PRIMARY KEY, item_id INTEGER, name TEXT DEFAULT '', handle TEXT DEFAULT '', platform TEXT DEFAULT '',
        stage TEXT DEFAULT 'messaged', meet TEXT DEFAULT '', note TEXT DEFAULT '', updated TEXT);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
    `);
    addColumn("buyers", "follow_up TEXT DEFAULT ''");
    addColumn("postings", "ended_by_sale INTEGER DEFAULT 0"); // the postings a sale ended, so undoing it puts exactly those back
    db.exec("UPDATE buyers SET stage='contacted' WHERE stage='messaged'");
  },
  () => {
    // 0.1.1: offers and the agreed price, structured pickup times, external take-down, per-item currency, reminder state.
    addColumn("buyers", "offer REAL");
    addColumn("buyers", "agreed_price REAL");
    addColumn("buyers", "pickup_at TEXT DEFAULT ''");
    addColumn("buyers", "before_sale TEXT DEFAULT ''"); // the status a buyer had before "Paid and picked up", for undo
    addColumn("postings", "removed_at TEXT DEFAULT ''"); // when the seller confirmed the real listing is down
    addColumn("items", "currency TEXT DEFAULT 'USD'");
    db.exec("CREATE TABLE IF NOT EXISTS reminder_state(ref TEXT PRIMARY KEY, move_key TEXT, state TEXT, until TEXT DEFAULT '', at TEXT)");
  },
];

function openDb() {
  fs.mkdirSync(PHOTOS, { recursive: true });
  const existed = fs.existsSync(DB_FILE);
  db = new DatabaseSync(DB_FILE);
  const version = db.prepare("PRAGMA user_version").get().user_version;
  const hasData = existed && db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n > 0;
  if (version < MIGRATIONS.length && hasData) console.log(`Backed up before upgrading the data: ${backup(`before-v${MIGRATIONS.length}`)}`);
  for (let v = version; v < MIGRATIONS.length; v++) tx(() => { MIGRATIONS[v](); db.exec(`PRAGMA user_version=${v + 1}`); });
  if (hasData) dailyBackup();
}

// Runs fn inside one transaction, so a sale or its undo is recorded completely or not at all.
function tx(fn) {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}

const getSettings = () => ({ ...SETTINGS, ...Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((r) => [r.key, r.value])) });

// ---------------------------------------------------------------- board

function getItem(id, settings = getSettings()) {
  const row = db.prepare("SELECT * FROM items WHERE id=?").get(id);
  if (!row) return null;
  const it = {
    ...JSON.parse(row.data || "{}"),
    id: row.id, created: row.created, sold_at: row.sold_at, sold_price: row.sold_price, currency: row.currency || "USD",
    photos: db.prepare("SELECT * FROM photos WHERE item_id=? ORDER BY id").all(id),
    postings: db.prepare("SELECT * FROM postings WHERE item_id=? ORDER BY id").all(id),
    buyers: db.prepare("SELECT * FROM buyers WHERE item_id=? ORDER BY id").all(id),
  };
  for (const b of it.buyers) b.move = moveOf(b, settings);
  const lead = leadBuyer(it);
  it.lead_id = lead ? lead.id : null;
  it.stage = stageOf(it, lead);
  const first = it.postings.map((p) => p.posted_at).filter(Boolean).sort()[0] || null;
  it.first_posted = first;
  it.days_listed = first ? daysSince(first, it.sold_at ? new Date(it.sold_at) : new Date()) : null;
  it.quiet = it.stage === "listed" && it.days_listed !== null && it.days_listed >= 3; // listed 3+ days with no messages
  return it;
}

// A reminder the seller marked done or dismissed stays hidden while its move is unchanged; a snoozed one comes back at its time.
function reminderShown(ref, key, at) {
  const st = db.prepare("SELECT * FROM reminder_state WHERE ref=?").get(ref);
  if (!st || st.move_key !== key) return { show: true };
  if (st.state === "snoozed") return new Date(st.until) <= at ? { show: true, due: st.until } : { show: false };
  return { show: false };
}

function board(at = new Date()) {
  const settings = getSettings();
  const items = db.prepare("SELECT id FROM items ORDER BY id DESC").all().map((r) => getItem(r.id, settings));
  const open = items.filter((i) => i.stage !== "sold" && i.stage !== "draft");
  const sold = items.filter((i) => i.stage === "sold");
  // Follow-ups that are due now, oldest first. Quiet listings count too: the move is to swap the wording.
  const reminders = [];
  let snoozed = 0;
  const add = (r) => {
    const s = reminderShown(r.ref, r.key, at);
    if (!s.show) { if (db.prepare("SELECT state FROM reminder_state WHERE ref=?").get(r.ref)?.state === "snoozed") snoozed++; return; }
    reminders.push({ ...r, due: s.due || r.due });
  };
  for (const i of items) {
    // After a sale the only follow-up left is the thank-you to the buyer who bought.
    for (const b of i.buyers) if (b.stage !== "dropped" && b.move?.is_due && (i.stage !== "sold" || b.stage === "bought"))
      add({ kind: "buyer", ref: `buyer:${b.id}`, key: b.move.key, item_id: i.id, item: i.name, buyer: b.name, stage: b.stage, text: b.move.text, due: b.move.due });
    if (i.quiet) add({ kind: "item", ref: `quiet:${i.id}`, key: `${i.first_posted}|${i.in_use || "first"}`, item_id: i.id, item: i.name, buyer: "", stage: "listed", text: `${i.days_listed} days with no messages: swap in the second version`, due: null });
    // A listing ended in Ember may still be up on the site itself until the seller says they took it down.
    for (const p of i.postings) if (p.status === "ended" && !p.removed_at)
      add({ kind: "posting", ref: `posting:${p.id}`, key: "takedown", posting_id: p.id, url: p.url, item_id: i.id, item: i.name, buyer: "", stage: "sold", text: `Take down the ${p.platform || "marketplace"} listing (still up there until you do)`, due: i.sold_at || null });
  }
  reminders.sort((a, b) => String(a.due || "9").localeCompare(String(b.due || "9")));
  const soldDays = sold.map((i) => i.days_listed).filter((d) => d !== null);
  // Totals are kept per currency, since amounts in different currencies can't be added up.
  const byCur = (arr, f) => arr.reduce((t, i) => { const n = Number(f(i)); if (n) t[i.currency] = (t[i.currency] || 0) + n; return t; }, {});
  return {
    version: VERSION,
    items,
    reminders,
    snoozed,
    settings,
    stats: {
      listed: open.length,
      listed_value: byCur(open, (i) => i.asking),
      in_talks: open.filter((i) => i.lead_id).length,
      sold: sold.length,
      sold_value: byCur(sold, (i) => i.sold_price),
      at_asking: sold.filter((i) => Number(i.asking) && Number(i.sold_price) >= Number(i.asking)).length,
      avg_days: soldDays.length ? Math.round((soldDays.reduce((a, b) => a + b, 0) / soldDays.length) * 10) / 10 : null,
    },
  };
}

// ---------------------------------------------------------------- validation

class Bad extends Error {}
const blank = (v) => v === undefined || v === null || String(v).trim() === "";
// A price is blank (unknown) or a number of zero or more; 0 is a real price (given away).
function price(v, what) {
  if (blank(v)) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Bad(`${what} must be a number of 0 or more.`);
  return n;
}
function checkFields(b, rules) {
  for (const [f, check] of Object.entries(rules)) if (b[f] !== undefined) check(b[f], f);
}
const priceRule = (v, f) => price(v, f);
const dateTimeRule = (v, f) => { if (!blank(v) && !isDateTime(v)) throw new Bad(`${f} must be a date and time.`); };
const ITEM_RULES = { asking: priceRule, new_price: priceRule, mkt_low: priceRule, mkt_mid: priceRule, mkt_high: priceRule,
  currency: (v) => { if (!CURRENCIES.includes(v)) throw new Bad(`Currency must be one of ${CURRENCIES.join(", ")}.`); } };
const BUYER_RULES = { offer: priceRule, agreed_price: priceRule, follow_up: dateTimeRule, pickup_at: dateTimeRule,
  stage: (v) => { if (!BUYER_STAGES.includes(v)) throw new Bad(`Unknown buyer status: ${v}`); } };
const POSTING_RULES = { posted_at: (v) => { if (v && !isYmd(v)) throw new Bad("posted_at must be YYYY-MM-DD."); },
  status: (v) => { if (!["live", "ended"].includes(v)) throw new Bad("A posting is live or ended."); } };
const SETTING_RULES = {
  local_off: (v) => { const n = Number(v); if (!blank(v) && !(n >= 0 && n <= 90)) throw new Bad("The local pickup discount is 0 to 90%."); },
  remind_mins: (v) => { const n = Number(v); if (!(Number.isInteger(n) && n >= 0 && n <= 1440)) throw new Bad("The pickup reminder is 0 to 1440 minutes before."); },
  region: (v) => { if (!REGIONS[v]) throw new Bad("Unknown region."); },
  currency: ITEM_RULES.currency,
};

// ---------------------------------------------------------------- http

const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 60e6) throw new Bad("Upload too large.");
    chunks.push(c);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { throw new Bad("The request was not valid JSON."); }
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
const BUYER_FIELDS = ["name", "handle", "platform", "stage", "meet", "note", "follow_up", "pickup_at"];
const pick = (obj, fields) => Object.fromEntries(fields.filter((f) => obj[f] !== undefined).map((f) => [f, obj[f]]));

function updateRow(table, id, fields, body, extra = {}) {
  const set = { ...pick(body, fields), ...extra };
  const keys = Object.keys(set);
  if (keys.length) db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(", ")} WHERE id=?`).run(...keys.map((k) => set[k] === null ? null : String(set[k] ?? "")), id);
}

// Records the sale: the price, the postings it ends, and (when a buyer is named) that buyer's handover. Run inside tx().
function sell(id, soldPrice, buyer) {
  {
    db.prepare("UPDATE items SET sold_at=?, sold_price=? WHERE id=?").run(now(), soldPrice, id);
    db.prepare("UPDATE postings SET status='ended', ended_by_sale=1 WHERE item_id=? AND status='live'").run(id);
    if (buyer && buyer.stage !== "bought") db.prepare("UPDATE buyers SET before_sale=?, stage='bought', updated=?, follow_up='' WHERE id=?").run(buyer.stage, now(), buyer.id);
  }
}
// Undoes it: the item is unsold, postings the sale ended go live again unless the seller already took them down,
// and the buyer goes back to the status they had. Their offer and agreed price are kept. Run inside tx().
function unsell(id) {
  {
    db.prepare("UPDATE items SET sold_at=NULL, sold_price=NULL WHERE id=?").run(id);
    db.prepare("UPDATE postings SET status='live', ended_by_sale=0 WHERE item_id=? AND ended_by_sale=1 AND removed_at=''").run(id);
    for (const b of db.prepare("SELECT * FROM buyers WHERE item_id=? AND stage IN ('bought','thanked') AND before_sale<>''").all(id))
      db.prepare("UPDATE buyers SET stage=?, before_sale='', updated=?, follow_up='' WHERE id=?").run(b.before_sale, now(), b.id);
  }
}

async function api(req, res, url) {
  const m = req.method;
  const p = url.pathname;
  let r;

  if (p === "/api/health" && m === "GET") return send(res, 200, { app: "ember", version: VERSION });
  if (p === "/api/board" && m === "GET") return send(res, 200, board());

  if (p === "/api/settings" && m === "PUT") {
    const b = await readBody(req);
    checkFields(b, SETTING_RULES);
    for (const k of Object.keys(SETTINGS)) if (b[k] !== undefined) db.prepare("INSERT INTO settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, String(b[k]));
    return send(res, 200, getSettings());
  }

  if (p === "/api/backup" && m === "POST") return send(res, 200, { backup: backup("manual"), folder: BACKUPS });

  if (p === "/api/reminders" && m === "POST") {
    const b = await readBody(req);
    if (!/^(buyer|quiet|posting):\d+$/.test(String(b.ref)) || !["done", "dismissed", "snoozed"].includes(b.state)) throw new Bad("Unknown reminder or action.");
    if (b.state === "snoozed" && !(b.until && isDateTime(b.until))) throw new Bad("Snooze needs a time.");
    db.prepare("INSERT INTO reminder_state(ref, move_key, state, until, at) VALUES(?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET move_key=excluded.move_key, state=excluded.state, until=excluded.until, at=excluded.at")
      .run(b.ref, String(b.key ?? ""), b.state, b.state === "snoozed" ? new Date(b.until).toISOString() : "", now());
    return send(res, 200, board());
  }

  if (p === "/api/items" && m === "POST") {
    const b = await readBody(req);
    checkFields(b, ITEM_RULES);
    const info = db.prepare("INSERT INTO items(created, data, currency) VALUES(?,?,?)").run(now(), JSON.stringify(pick(b, ITEM_FIELDS)), b.currency || getSettings().currency);
    return send(res, 200, getItem(Number(info.lastInsertRowid)));
  }

  if ((r = p.match(/^\/api\/items\/(\d+)$/))) {
    const id = Number(r[1]);
    const row = db.prepare("SELECT * FROM items WHERE id=?").get(id);
    if (!row) return send(res, 404, { error: "No such item" });
    if (m === "PUT") {
      const b = await readBody(req);
      checkFields(b, ITEM_RULES);
      const data = { ...JSON.parse(row.data || "{}"), ...pick(b, ITEM_FIELDS) };
      db.prepare("UPDATE items SET data=? WHERE id=?").run(JSON.stringify(data), id);
      if (b.currency) db.prepare("UPDATE items SET currency=? WHERE id=?").run(b.currency, id);
      if (b.sold === true && !row.sold_at) { const sp = price(b.sold_price, "The sold price"); tx(() => sell(id, sp, null)); }
      if (b.sold === false && row.sold_at) tx(() => unsell(id));
      return send(res, 200, getItem(id));
    }
    if (m === "DELETE") {
      const photos = db.prepare("SELECT * FROM photos WHERE item_id=?").all(id);
      tx(() => {
        for (const t of ["photos", "postings", "buyers"]) db.prepare(`DELETE FROM ${t} WHERE item_id=?`).run(id);
        db.prepare("DELETE FROM items WHERE id=?").run(id);
      });
      for (const ph of photos) fs.rmSync(path.join(PHOTOS, ph.file), { force: true });
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
    checkFields(b, POSTING_RULES);
    db.prepare("INSERT INTO postings(item_id, platform, url, posted_at, status) VALUES(?,?,?,?,?)").run(Number(r[1]), b.platform || "", b.url || "", b.posted_at || today(), b.status || "live");
    return send(res, 200, getItem(Number(r[1])));
  }
  if ((r = p.match(/^\/api\/postings\/(\d+)$/))) {
    const row = db.prepare("SELECT * FROM postings WHERE id=?").get(Number(r[1]));
    if (!row) return send(res, 404, { error: "No such posting" });
    if (m === "PUT") {
      const b = await readBody(req);
      checkFields(b, POSTING_RULES);
      const extra = {};
      // A status set by hand is the owner's call, so a later "undo sale" leaves it alone. Going live again means it is up again.
      if (b.status !== undefined) Object.assign(extra, { ended_by_sale: 0 }, b.status === "live" ? { removed_at: "" } : {});
      // "I took it down" is the seller's own confirmation; Ember never removes anything from a marketplace itself.
      if (b.removed === true) Object.assign(extra, { status: "ended", removed_at: now() });
      if (b.removed === false) extra.removed_at = "";
      updateRow("postings", row.id, POSTING_FIELDS, b, extra);
    }
    if (m === "DELETE") db.prepare("DELETE FROM postings WHERE id=?").run(row.id);
    return send(res, 200, getItem(row.item_id));
  }

  if ((r = p.match(/^\/api\/items\/(\d+)\/buyers$/)) && m === "POST") {
    if (!itemExists(Number(r[1]))) return send(res, 404, { error: "No such item" });
    const b = await readBody(req);
    checkFields(b, BUYER_RULES);
    db.prepare("INSERT INTO buyers(item_id, name, handle, platform, stage, meet, note, updated) VALUES(?,?,?,?,?,?,?,?)")
      .run(Number(r[1]), b.name || "", b.handle || "", b.platform || "", b.stage || "contacted", b.meet || "", b.note || "", now());
    return send(res, 200, getItem(Number(r[1])));
  }
  if ((r = p.match(/^\/api\/buyers\/(\d+)$/))) {
    const row = db.prepare("SELECT * FROM buyers WHERE id=?").get(Number(r[1]));
    if (!row) return send(res, 404, { error: "No such buyer" });
    if (m === "PUT") {
      const b = await readBody(req);
      checkFields(b, BUYER_RULES);
      const item = db.prepare("SELECT * FROM items WHERE id=?").get(row.item_id);
      // "Paid and picked up" records the sale at the price the seller confirmed (the agreed price unless corrected).
      if (b.stage === "bought" && !item.sold_at) {
        const agreed = b.agreed_price !== undefined ? price(b.agreed_price, "The agreed price") : row.agreed_price;
        const asking = Number(JSON.parse(item.data || "{}").asking);
        const soldPrice = b.sold_price !== undefined ? price(b.sold_price, "The sold price") : agreed ?? (Number.isFinite(asking) && String(JSON.parse(item.data || "{}").asking).trim() !== "" ? asking : null);
        tx(() => {
          if (b.agreed_price !== undefined) db.prepare("UPDATE buyers SET agreed_price=? WHERE id=?").run(agreed, row.id);
          sell(item.id, soldPrice, row);
        });
        return send(res, 200, getItem(row.item_id));
      }
      // A change of status is the buyer's (or the seller's) latest move: it restarts the clock and clears any follow-up time set for the old status.
      const moved = b.stage !== undefined && b.stage !== row.stage;
      const extra = moved ? { updated: now(), follow_up: b.follow_up ?? "" } : {};
      for (const f of ["offer", "agreed_price"]) if (b[f] !== undefined) extra[f] = price(b[f], f === "offer" ? "The offer" : "The agreed price");
      updateRow("buyers", row.id, BUYER_FIELDS, b, extra);
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

// ---------------------------------------------------------------- start-up, --check and --restore

// What is on the port: "ember" (a running Ember), "free", or "other" (some other program).
export function probe(port = PORT) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", headers: { Host: `localhost:${port}` }, timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve(JSON.parse(body).app === "ember" ? "ember" : "other"); } catch { resolve("other"); } });
    });
    req.on("timeout", () => { req.destroy(); resolve("other"); });
    req.on("error", (e) => resolve(e.code === "ECONNREFUSED" ? "free" : "other"));
  });
}

let DatabaseSync;

async function restore(name) {
  const list = fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((n) => fs.existsSync(path.join(BACKUPS, n, "listings.db"))).sort() : [];
  if (!name) {
    console.log(list.length ? `Backups in ${BACKUPS}, oldest first:\n  ${list.join("\n  ")}\n\nTo put one back: node server.js --restore <name>` : `No backups yet in ${BACKUPS}.`);
    return 0;
  }
  if (!list.includes(name)) { console.error(`No backup called "${name}". Run "node server.js --restore" to list them.`); return 1; }
  if ((await probe()) === "ember") { console.error("Ember is running. Close its window first, then restore."); return 1; }
  // The current data is backed up first, so a restore can itself be undone.
  if (fs.existsSync(DB_FILE)) { db = new DatabaseSync(DB_FILE); console.log(`Saved the current data as ${backup("before-restore")}`); db.close(); }
  const src = path.join(BACKUPS, name);
  // Opening the copy proves it is a readable database before it replaces anything.
  new DatabaseSync(path.join(src, "listings.db"), { readOnly: true }).prepare("SELECT count(*) FROM sqlite_master").get();
  fs.copyFileSync(path.join(src, "listings.db"), DB_FILE);
  for (const f of ["-wal", "-shm"]) fs.rmSync(DB_FILE + f, { force: true });
  fs.rmSync(PHOTOS, { recursive: true, force: true });
  if (fs.existsSync(path.join(src, "photos"))) fs.cpSync(path.join(src, "photos"), PHOTOS, { recursive: true });
  console.log(`Restored ${name}. Start Ember again to use it.`);
  return 0;
}

async function main(args) {
  if (args[0] === "--check") {
    if (!nodeSupported()) { console.error(`Ember needs Node.js ${MIN_NODE} or newer; this PC has ${process.versions.node}. Install the current LTS from https://nodejs.org.`); return 3; }
    const s = await probe();
    if (s === "other") console.error(`Port ${PORT} is in use by another program, not Ember.`);
    return { ember: 0, free: 1, other: 2 }[s];
  }
  if (!nodeSupported()) {
    console.error(`Ember needs Node.js ${MIN_NODE} or newer; this PC has ${process.versions.node}.\nInstall the current LTS from https://nodejs.org, then start Ember again.`);
    return 1;
  }
  ({ DatabaseSync } = await import("node:sqlite"));
  if (args[0] === "--restore") return restore(args[1]);

  openDb();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!allowed(req, url)) return send(res, 403, { error: "Forbidden" });
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (url.pathname.startsWith("/photos/")) return serveFile(res, PHOTOS, decodeURIComponent(url.pathname.slice(8)));
      return serveFile(res, path.join(here, "public"), url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
    } catch (err) {
      if (!(err instanceof Bad)) console.error(err);
      if (!res.headersSent) send(res, err instanceof Bad ? 400 : 500, { error: String(err?.message || err) });
    }
  });
  server.on("error", async (e) => {
    if (e.code !== "EADDRINUSE") throw e;
    console.error((await probe()) === "ember"
      ? `Ember is already running at http://localhost:${PORT}. Use that window; this one can be closed.`
      : `Port ${PORT} is in use by another program, so Ember can't start. Close that program, or start Ember with another port (set PORT=4320).`);
    process.exit(1);
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`Ember ${VERSION} is running at http://localhost:${PORT}`));
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { if (code !== null) process.exitCode = code; }, (e) => { console.error(e); process.exitCode = 1; });
}
