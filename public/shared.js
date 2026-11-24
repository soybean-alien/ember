// Ember by soybean_alien
// Shared by the desk and the wall: the stages, their colours, and the ember (how recently a buyer moved).

const STAGES = [
  { key: "draft", label: "Draft", short: "Draft", c: "#7f8db0" },
  { key: "listed", label: "Listed", short: "Listed", c: "#4da3ff" },
  { key: "contacted", label: "They contacted me", short: "Contacted", c: "#ff7a1a" },
  { key: "asked", label: "They asked a question", short: "Question", c: "#ffd23f" },
  { key: "countered", label: "They counteroffered", short: "Counteroffer", c: "#ff5d73" },
  { key: "thinking", label: "They're thinking it over", short: "Thinking", c: "#b48cff" },
  { key: "silent", label: "They haven't responded", short: "No reply", c: "#7fd6e8" },
  { key: "accepted", label: "They accepted", short: "Accepted", c: "#b6f23c" },
  { key: "pickup", label: "Pickup set", short: "Pickup set", c: "#2ee6c0" },
  { key: "sold", label: "Sold", short: "Sold", c: "#3ddc84" },
];
const STAGE = Object.fromEntries(STAGES.map((s) => [s.key, s]));
const DEAL_KEYS = ["contacted", "asked", "countered", "thinking", "silent"];

// One buyer's status. The first five are where a conversation can sit; from "Accepted" on, the deal is closing out.
const BUYER_STATUS = [
  { key: "contacted", label: "Contacted me", c: STAGE.contacted.c },
  { key: "asked", label: "Asked a question", c: STAGE.asked.c },
  { key: "countered", label: "Counteroffered", c: STAGE.countered.c },
  { key: "thinking", label: "Thinking it over", c: STAGE.thinking.c },
  { key: "silent", label: "No reply", c: STAGE.silent.c },
  { key: "accepted", label: "Accepted", c: STAGE.accepted.c },
  { key: "time set", label: "Pickup time set", c: STAGE.pickup.c },
  { key: "confirmed", label: "Pickup confirmed", c: STAGE.pickup.c },
  { key: "bought", label: "Paid and picked up", c: STAGE.sold.c },
  { key: "thanked", label: "Feedback asked, closed", c: STAGE.sold.c },
  { key: "dropped", label: "Dropped out", c: STAGE.draft.c },
];
const BUYER = Object.fromEntries(BUYER_STATUS.map((s) => [s.key, s]));
const CLOSING = ["accepted", "time set", "confirmed", "bought"];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Region and currency come from the settings. Each amount is shown in its own item's currency; nothing is converted.
const REGION_LOCALE = { US: "en-US", UK: "en-GB", IE: "en-IE", DE: "de-DE" };
const REGION_EBAY = { US: "www.ebay.com", UK: "www.ebay.co.uk", IE: "www.ebay.ie", DE: "www.ebay.de" };
let LOCALE = "en-US", CURRENCY = "USD", EBAY = "www.ebay.com";
function useSettings(s = {}) {
  LOCALE = REGION_LOCALE[s.region] || "en-US";
  EBAY = REGION_EBAY[s.region] || "www.ebay.com";
  CURRENCY = s.currency || "USD";
}
const money = (n, digits = 2, cur = CURRENCY) => (n === null || n === undefined || n === "" || !Number.isFinite(Number(n)) ? ""
  : new Intl.NumberFormat(LOCALE, { style: "currency", currency: cur || CURRENCY, minimumFractionDigits: 0, maximumFractionDigits: digits }).format(Number(n)));
const symbol = (cur = CURRENCY) => new Intl.NumberFormat(LOCALE, { style: "currency", currency: cur }).formatToParts(0).find((p) => p.type === "currency").value;
// A total kept per currency, e.g. "£80 + $25". Empty totals show as zero in the default currency.
const totals = (byCur, digits = 2) => Object.entries(byCur || {}).map(([c, n]) => money(n, digits, c)).join(" + ") || money(0, 0);
const dateOf = (iso) => new Date(iso).toLocaleDateString(LOCALE);
const whenOf = (iso) => new Date(iso).toLocaleString(LOCALE, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
// The price a buyer agreed, or the asking price if none was recorded.
const dealPrice = (item, buyer) => (buyer && buyer.agreed_price !== null && buyer.agreed_price !== undefined && buyer.agreed_price !== "" ? buyer.agreed_price : item.asking);
const days = (n) => `${n} ${n === 1 ? "day" : "days"}`;
const ticket = (id) => `EM-${String(id).padStart(4, "0")}`;

function ago(iso) {
  const m = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 6e4));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  return `${days(Math.floor(m / 1440))} ago`;
}
// The ember: 1 the moment a buyer moves, cooling to 0 over two days. Buyers are warm for a short while; this shows how long is left.
const heat = (iso) => Math.max(0, 1 - (Date.now() - new Date(iso)) / (48 * 36e5));
const ember = (iso) => `<span class="ember" style="--h:${heat(iso).toFixed(2)}" title="Last move ${esc(ago(iso))}"></span>`;
const leadOf = (i) => i.buyers.find((b) => b.id === i.lead_id) || null;

// The message sent two or three days after the handover: thanks, and one honest ask for feedback with no pressure attached.
function thankYou(item, buyer) {
  return [
    `Hi${buyer.name ? " " + buyer.name.split(" ")[0] : ""}, I wanted to check in now that you've had the ${item.name || "item"} for a few days. I hope it's working out well for you, and thank you again.`,
    "",
    "Feedback on our transaction is important to me. It isn't required, and most people don't leave it, but I'd appreciate it if you did.",
    "",
    "If anything isn't as I described, message me and I'll make it right.",
  ].join("\n");
}

// The message sent once a buyer accepts: thanks, then every detail needed to finish, so nothing is left to ask.
function wrapUp(item, buyer, s) {
  const where = [s.spot, s.area].filter(Boolean).join(", ");
  return [
    `Hi${buyer.name ? " " + buyer.name.split(" ")[0] : ""}, thank you for your interest in the ${item.name || "item"}. I appreciate it. Let's wrap this up and confirm the details so I can get it to you.`,
    "",
    money(dealPrice(item, buyer), 2, item.currency) ? `Price: ${money(dealPrice(item, buyer), 2, item.currency)}` : "",
    `Payment: ${s.payment}, at pickup`,
    where ? `Pickup only: ${where}` : "Pickup only",
    buyer.pickup_at ? `Time: ${whenOf(buyer.pickup_at)}` : buyer.meet ? `Time: ${buyer.meet}` : "Time: what day and time works for you? I can do today or tomorrow.",
    "",
    "You're welcome to look it over before you pay. Reply to confirm and I'll have it ready for you.",
  ].filter((l, k, a) => l !== "" || a[k - 1] !== "").join("\n");
}
