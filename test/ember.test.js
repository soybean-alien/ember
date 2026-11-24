// Ember by soybean_alien
// Regression tests for 0.1.1, with Node's built-in test runner: npm test
// Each test starts the real server on a spare port with its own throwaway data folder.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { moveOf, nodeSupported } from "../server.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(root, "server.js");
let nextPort = 4400 + Math.floor(Math.random() * 500);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-test-"));

function start(data = tmp(), port = nextPort++) {
  const env = { ...process.env, EMBER_DATA: data, PORT: String(port) };
  const proc = spawn(process.execPath, [SERVER], { env });
  let out = "";
  proc.stdout.on("data", (c) => (out += c));
  proc.stderr.on("data", (c) => (out += c));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start: " + out)), 10000);
    proc.stdout.on("data", () => { if (out.includes("is running")) { clearTimeout(t); resolve({ proc, port, data, env, out: () => out, call: (m, u, b) => call(port, m, u, b) }); } });
    proc.on("exit", () => { clearTimeout(t); reject(new Error("server exited: " + out)); });
  });
}
const stop = (s) => new Promise((r) => { if (s.proc.exitCode !== null) return r(); s.proc.once("exit", r); s.proc.kill(); });

function call(port, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: url, method, headers: { Host: `localhost:${port}`, "Content-Type": "application/json" } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode, body: t ? JSON.parse(t) : null }));
    });
    req.on("error", reject);
    req.end(data);
  });
}
const ok = async (p) => { const r = await p; assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body; };

// The desk's own helpers, loaded the way the browser loads them.
function shared(settings) {
  const ctx = { Intl, Date, Number, String, Object, Math };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, "public", "shared.js"), "utf8") + "\nthis.api = { useSettings, money, totals, wrapUp, dealPrice, get EBAY() { return EBAY; } };", ctx);
  ctx.api.useSettings(settings);
  return ctx.api;
}

let s;
before(async () => { s = await start(); });
after(() => stop(s));

async function itemWithBuyer(asking = 100, currency = "GBP") {
  const it = await ok(s.call("POST", "/api/items", { name: "Lamp", asking, currency }));
  await ok(s.call("POST", `/api/items/${it.id}/postings`, { platform: "Facebook Marketplace", url: "https://example.test/1" }));
  const withBuyer = await ok(s.call("POST", `/api/items/${it.id}/buyers`, { name: "Sam Lee" }));
  return { id: it.id, buyer: withBuyer.buyers[0].id };
}

// ---------------------------------------------------------------- 01 agreed price

test("01: a £100 item agreed at £80 is confirmed and sold at £80, and undo keeps the negotiation", async () => {
  const { id, buyer } = await itemWithBuyer(100, "GBP");
  await ok(s.call("PUT", `/api/buyers/${buyer}`, { offer: 75 }));
  let it = await ok(s.call("PUT", `/api/buyers/${buyer}`, { stage: "accepted", agreed_price: 80 }));
  const b = it.buyers[0];
  assert.equal(b.agreed_price, 80);
  const msg = shared({ region: "UK", currency: "GBP" }).wrapUp(it, b, { payment: "cash", spot: "", area: "" });
  assert.match(msg, /Price: £80\b/);
  assert.doesNotMatch(msg, /£100/);

  await ok(s.call("PUT", `/api/buyers/${buyer}`, { stage: "time set" }));
  it = await ok(s.call("PUT", `/api/buyers/${buyer}`, { stage: "bought" })); // no correction given: the agreed price is used
  assert.equal(it.sold_price, 80);
  assert.equal(it.stage, "sold");
  const board = await ok(s.call("GET", "/api/board"));
  assert.equal(board.stats.sold_value.GBP >= 80, true);

  it = await ok(s.call("PUT", `/api/items/${id}`, { sold: false }));
  assert.equal(it.sold_at, null);
  assert.equal(it.sold_price, null);
  assert.equal(it.buyers[0].stage, "time set", "the buyer goes back to the status before the sale");
  assert.equal(it.buyers[0].agreed_price, 80);
  assert.equal(it.buyers[0].offer, 75);
  assert.equal(it.postings[0].status, "live");
});

test("01: the sold price can be corrected when recording the handover", async () => {
  const { buyer } = await itemWithBuyer(100);
  await ok(s.call("PUT", `/api/buyers/${buyer}`, { stage: "accepted", agreed_price: 80 }));
  const it = await ok(s.call("PUT", `/api/buyers/${buyer}`, { stage: "bought", sold_price: 70 }));
  assert.equal(it.sold_price, 70);
});

// ---------------------------------------------------------------- 02 take-down checklist

test("02: every listing stays on the take-down checklist until the seller confirms it", async () => {
  const { id, buyer } = await itemWithBuyer();
  await ok(s.call("POST", `/api/items/${id}/postings`, { platform: "eBay", url: "https://example.test/2" }));
  await ok(s.call("PUT", `/api/buyers/${buyer}`, { stage: "bought", sold_price: 90 }));
  let board = await ok(s.call("GET", "/api/board"));
  const mine = () => board.reminders.filter((r) => r.kind === "posting" && r.item_id === id);
  assert.equal(mine().length, 2);
  assert.match(mine()[0].text, /still up there until you do/);
  const it = board.items.find((i) => i.id === id);
  assert.ok(it.postings.every((p) => p.status === "ended" && !p.removed_at), "ended in Ember is not the same as taken down");

  await ok(s.call("PUT", `/api/postings/${mine()[0].posting_id}`, { removed: true }));
  board = await ok(s.call("GET", "/api/board"));
  assert.equal(mine().length, 1);

  // Undoing the sale puts back only the listing that is still up; the one taken down stays down.
  const after = await ok(s.call("PUT", `/api/items/${id}`, { sold: false }));
  assert.deepEqual(after.postings.map((p) => p.status).sort(), ["ended", "live"]);
});

// ---------------------------------------------------------------- 03 pickup reminder

test("03: a pickup at 18:00 reminds at 17:00, and moving it to 19:00 moves the reminder to 18:00", () => {
  const b = { stage: "confirmed", updated: "2026-11-24T09:00:00", follow_up: "", pickup_at: "2026-11-24T18:00" };
  const at = new Date("2026-11-24T12:00");
  assert.equal(new Date(moveOf(b, { remind_mins: "60" }, at).due).getTime(), new Date("2026-11-24T17:00").getTime());
  const moved = moveOf({ ...b, pickup_at: "2026-11-24T19:00" }, { remind_mins: "60" }, at);
  assert.equal(new Date(moved.due).getTime(), new Date("2026-11-24T18:00").getTime());
  assert.notEqual(moved.key, moveOf(b, { remind_mins: "60" }, at).key, "a reschedule is a new reminder");
  assert.equal(moveOf(b, { remind_mins: "60" }, new Date("2026-11-24T16:59")).is_due, false);
  assert.equal(moveOf(b, { remind_mins: "60" }, new Date("2026-11-24T17:00")).is_due, true);
  assert.equal(new Date(moveOf(b, { remind_mins: "30" }, at).due).getTime(), new Date("2026-11-24T17:30").getTime());
  assert.match(moveOf(b, {}, new Date("2026-11-24T18:30")).text, /has passed/);
});

test("03: an overdue pickup reminder shows on the next load; a dropped buyer has none", async () => {
  const { buyer } = await itemWithBuyer();
  const past = new Date(Date.now() - 30 * 6e4);
  const local = new Date(past.getTime() - past.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
  await ok(s.call("PUT", `/api/buyers/${buyer}`, { stage: "confirmed" }));
  await ok(s.call("PUT", `/api/buyers/${buyer}`, { pickup_at: local }));
  let board = await ok(s.call("GET", "/api/board"));
  assert.ok(board.reminders.some((r) => r.ref === `buyer:${buyer}`));
  await ok(s.call("PUT", `/api/buyers/${buyer}`, { stage: "dropped" }));
  board = await ok(s.call("GET", "/api/board"));
  assert.ok(!board.reminders.some((r) => r.ref === `buyer:${buyer}`));
});

// ---------------------------------------------------------------- 04 region and currency

test("04: UK settings show £, UK dates and ebay.co.uk; amounts keep their own currency", async () => {
  const uk = shared({ region: "UK", currency: "GBP" });
  assert.equal(uk.money(80), "£80");
  assert.equal(uk.money(1234.5), "£1,234.5");
  assert.equal(uk.money(25, 2, "USD"), "US$25");
  assert.equal(uk.EBAY, "www.ebay.co.uk");
  assert.equal(uk.totals({ GBP: 80, USD: 25 }), "£80 + US$25");
  assert.equal(new Date("2026-11-24T12:00").toLocaleDateString("en-GB"), "24/11/2026");
  const us = shared({ region: "US", currency: "USD" });
  assert.equal(us.money(80), "$80");
  assert.equal(us.EBAY, "www.ebay.com");

  await ok(s.call("PUT", "/api/settings", { region: "UK", currency: "GBP" }));
  const it = await ok(s.call("POST", "/api/items", { name: "Kettle", asking: 20 }));
  assert.equal(it.currency, "GBP", "new items take the chosen currency");
  await ok(s.call("PUT", "/api/settings", { currency: "USD" }));
  const again = await ok(s.call("GET", `/api/items/${it.id}`));
  assert.equal(again.currency, "GBP", "changing the setting never converts existing items");
  assert.equal((await s.call("PUT", "/api/settings", { currency: "JPY" })).status, 400);
});

// ---------------------------------------------------------------- 05 reminder actions

test("05: Done and Dismiss stop a reminder, Snooze brings it back, and the buyer's status never changes", async () => {
  const { buyer } = await itemWithBuyer();
  const ref = `buyer:${buyer}`;
  const find = async () => (await ok(s.call("GET", "/api/board"))).reminders.find((r) => r.ref === ref);
  let r = await find();
  assert.ok(r, "a new contact is due straight away");

  await ok(s.call("POST", "/api/reminders", { ref, key: r.key, state: "done" }));
  assert.equal(await find(), undefined);
  assert.equal((await ok(s.call("GET", `/api/items/${(await ok(s.call("GET", "/api/board"))).items.find((i) => i.buyers.some((b) => b.id === buyer)).id}`))).buyers[0].stage, "contacted");

  // A new move by the buyer is a new reminder.
  await ok(s.call("PUT", `/api/buyers/${buyer}`, { stage: "asked" }));
  r = await find();
  assert.ok(r);
  const board = await ok(s.call("POST", "/api/reminders", { ref, key: r.key, state: "snoozed", until: new Date(Date.now() + 36e5).toISOString() }));
  assert.ok(!board.reminders.some((x) => x.ref === ref));
  assert.ok(board.snoozed >= 1);
  await ok(s.call("POST", "/api/reminders", { ref, key: r.key, state: "snoozed", until: new Date(Date.now() - 1000).toISOString() }));
  assert.ok(await find(), "a snooze that has run out shows the reminder again");

  await ok(s.call("POST", "/api/reminders", { ref, key: r.key, state: "dismissed" }));
  assert.equal(await find(), undefined);
  assert.equal((await s.call("POST", "/api/reminders", { ref, key: r.key, state: "snoozed" })).status, 400, "snooze needs a time");
});

// ---------------------------------------------------------------- validation and failed saves

test("bad input is refused with a clear message and saves nothing", async () => {
  const { id, buyer } = await itemWithBuyer(50);
  for (const [url, body] of [
    [`/api/items/${id}`, { asking: "abc" }],
    [`/api/items/${id}`, { asking: -5 }],
    [`/api/items/${id}`, { sold: true, sold_price: "lots" }],
    [`/api/buyers/${buyer}`, { stage: "bogus" }],
    [`/api/buyers/${buyer}`, { agreed_price: -1 }],
    [`/api/buyers/${buyer}`, { pickup_at: "next tuesday-ish" }],
    ["/api/settings", { remind_mins: 99999 }],
  ]) {
    const r = await s.call("PUT", url, body);
    assert.equal(r.status, 400, `${url} ${JSON.stringify(body)}`);
    assert.ok(r.body.error);
  }
  assert.equal((await s.call("PUT", `/api/items/${id}`, "{not json")).status, 400);
  const it = await ok(s.call("GET", `/api/items/${id}`));
  assert.equal(it.asking, 50);
  assert.equal(it.sold_at, null);
});

test("two sales of the same item at once record one sale", async () => {
  const { id } = await itemWithBuyer(40);
  await Promise.all([s.call("PUT", `/api/items/${id}`, { sold: true, sold_price: 40 }), s.call("PUT", `/api/items/${id}`, { sold: true, sold_price: 35 })]);
  const it = await ok(s.call("GET", `/api/items/${id}`));
  assert.equal(it.stage, "sold");
  assert.equal(it.sold_price, 40);
});

// ---------------------------------------------------------------- 06 launching twice

test("06: a second start finds the running Ember; --check tells Ember, a free port and another program apart", async () => {
  const check = (port) => { try { execFileSync(process.execPath, [SERVER, "--check"], { env: { ...process.env, PORT: String(port) }, stdio: "pipe" }); return 0; } catch (e) { return e.status; } };
  assert.equal(check(s.port), 0);
  assert.equal(check(nextPort++), 1);

  const other = http.createServer((q, r) => r.end("hello")).listen(0, "127.0.0.1");
  await new Promise((r) => other.once("listening", r));
  assert.equal(check(other.address().port), 2);
  other.close();

  // Starting the server again on the same port leaves the first one running and says so.
  const second = spawn(process.execPath, [SERVER], { env: { ...process.env, EMBER_DATA: s.data, PORT: String(s.port) } });
  let out = "";
  second.stderr.on("data", (c) => (out += c));
  const code = await new Promise((r) => second.on("exit", r));
  assert.equal(code, 1);
  assert.match(out, /already running/);
  assert.equal((await ok(s.call("GET", "/api/health"))).app, "ember");
});

// ---------------------------------------------------------------- 07 Node version

test("07: the minimum Node version is 22.13 (or 23.4 on the 23 line)", () => {
  for (const [v, want] of [["22.5.0", false], ["22.12.0", false], ["22.13.0", true], ["22.20.1", true], ["23.3.0", false], ["23.4.0", true], ["24.20.0", true], ["26.0.0", true]]) assert.equal(nodeSupported(v), want, v);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(pkg.engines.node, ">=22.13");
  assert.match(fs.readFileSync(path.join(root, "installer", "Ember.iss"), "utf8"), /v\[0\]==22&&v\[1\]>=13/);
});

// ---------------------------------------------------------------- upgrade, backup and restore

test("a 0.1.0 database upgrades with nothing lost, after a backup, and a backup restores", async () => {
  const data = tmp();
  fs.mkdirSync(path.join(data, "photos"), { recursive: true });
  fs.writeFileSync(path.join(data, "photos", "1-a.jpg"), "photo");
  const old = new DatabaseSync(path.join(data, "listings.db"));
  old.exec(`
    CREATE TABLE items(id INTEGER PRIMARY KEY, created TEXT, sold_at TEXT, sold_price REAL, data TEXT DEFAULT '{}');
    CREATE TABLE photos(id INTEGER PRIMARY KEY, item_id INTEGER, file TEXT);
    CREATE TABLE postings(id INTEGER PRIMARY KEY, item_id INTEGER, platform TEXT DEFAULT '', url TEXT DEFAULT '', posted_at TEXT DEFAULT '', status TEXT DEFAULT 'live');
    CREATE TABLE buyers(id INTEGER PRIMARY KEY, item_id INTEGER, name TEXT DEFAULT '', handle TEXT DEFAULT '', platform TEXT DEFAULT '', stage TEXT DEFAULT 'messaged', meet TEXT DEFAULT '', note TEXT DEFAULT '', updated TEXT);
    CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
    ALTER TABLE buyers ADD COLUMN follow_up TEXT DEFAULT '';
    ALTER TABLE postings ADD COLUMN ended_by_sale INTEGER DEFAULT 0;
    INSERT INTO items(id, created, data) VALUES(1, '2026-11-20T10:00:00Z', '{"name":"Bike","asking":"120"}');
    INSERT INTO photos(item_id, file) VALUES(1, '1-a.jpg');
    INSERT INTO postings(item_id, platform, posted_at) VALUES(1, 'eBay', '2026-11-20');
    INSERT INTO buyers(item_id, name, stage, updated) VALUES(1, 'Ana', 'thinking', '2026-11-21T10:00:00Z');
    INSERT INTO settings VALUES('spot', 'Library');
  `);
  old.close();

  let srv = await start(data);
  const it = await ok(srv.call("GET", "/api/items/1"));
  assert.equal(it.name, "Bike");
  assert.equal(it.asking, "120");
  assert.equal(it.currency, "USD", "existing items keep dollars rather than being converted");
  assert.equal(it.photos.length, 1);
  assert.equal(it.postings[0].platform, "eBay");
  assert.equal(it.buyers[0].name, "Ana");
  assert.equal(it.buyers[0].stage, "thinking");
  assert.equal((await ok(srv.call("GET", "/api/board"))).settings.spot, "Library");
  await stop(srv);

  const backups = fs.readdirSync(path.join(data, "backups"));
  const pre = backups.find((n) => n.endsWith("-before-v2"));
  assert.ok(pre, backups.join(","));
  assert.ok(fs.existsSync(path.join(data, "backups", pre, "photos", "1-a.jpg")));
  const upgraded = new DatabaseSync(path.join(data, "listings.db"));
  assert.equal(upgraded.prepare("PRAGMA user_version").get().user_version, 2);
  upgraded.exec("DELETE FROM buyers"); // something goes wrong after the upgrade...
  upgraded.close();

  // ...and the pre-upgrade backup puts it back, after saving the current state.
  const run = (...a) => execFileSync(process.execPath, [SERVER, "--restore", ...a], { env: { ...process.env, EMBER_DATA: data, PORT: String(nextPort++) }, encoding: "utf8" });
  assert.match(run(), new RegExp(pre));
  assert.match(run(pre), /Restored/);
  assert.ok(fs.readdirSync(path.join(data, "backups")).some((n) => n.endsWith("-before-restore")));
  srv = await start(data);
  assert.equal((await ok(srv.call("GET", "/api/items/1"))).buyers[0].name, "Ana");
  await stop(srv);
});
