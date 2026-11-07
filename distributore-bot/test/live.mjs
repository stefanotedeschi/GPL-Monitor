// Prova dal vivo con le API vere: node test/live.mjs [lat] [lng] [carburante]
import { buildReply, findBest, normalizeSettings, OSPZ_SEARCH_URL } from "../src/logic.js";

const [lat = "44.3845", lng = "7.5427", fuel = "gpl"] = process.argv.slice(2);
const origin = { lat: Number(lat), lng: Number(lng) };
const settings = normalizeSettings({ fuel });

const raw = await fetch(OSPZ_SEARCH_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
  body: JSON.stringify({ points: [origin], radius: 3, fuelType: "4-x", priceOrder: "asc" }),
});
const text = await raw.text();
console.log(`search/zone HTTP ${raw.status}, esempio risposta:\n${text.slice(0, 1200)}\n`);

const result = await findBest(fetch, origin, settings);
console.log(`Distributori trovati: ${result.count}, distanze su strada: ${result.routed}\n`);
console.log(buildReply(result, settings));
if (!result.count) process.exit(1);
