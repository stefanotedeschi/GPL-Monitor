import assert from "node:assert/strict";
import test from "node:test";
import { prettyName, applyCommand, buildReply, DEFAULTS, findBest, normalizeSettings, parseStations, totalCost } from "../src/logic.js";

const origin = { lat: 44.3845, lng: 7.5427 }; // Cuneo

// Risposta finta di search/zone: A vicino ma caro, B più lontano ed economico, C senza GPL.
const zone = {
  success: true,
  results: [
    { id: 1, name: "Vicino", brand: "Q8", address: "Via Roma 1", location: { lat: 44.3855, lng: 7.5437 },
      fuels: [{ fuelId: 4, name: "GPL", price: 0.799, isSelf: false }] },
    { id: 2, name: "Lontano", brand: "Esso", address: "Via Torino 5", location: { lat: 44.42, lng: 7.58 },
      fuels: [{ fuelId: 4, name: "GPL", price: 0.699, isSelf: false }, { fuelId: 1, name: "Benzina", price: 1.7, isSelf: true }] },
    { id: 3, name: "Senza GPL", location: { lat: 44.39, lng: 7.55 }, fuels: [{ fuelId: 2, name: "Gasolio", price: 1.6 }] },
  ],
};

function fakeFetch({ osrmFails = false } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("ospzApi")) return new Response(JSON.stringify(zone));
    if (osrmFails) return new Response("err", { status: 503 });
    const n = url.split("/").pop().split("?")[0].split(";").length;
    // distanze: 0, 0.3 km, 6 km per ciascuna destinazione nell'ordine ricevuto
    const coords = url.split("/").pop().split("?")[0].split(";");
    const dist = coords.map((c, i) => (i === 0 ? 0 : c.startsWith("7.543700") ? 300 : 6000));
    return new Response(JSON.stringify({ code: "Ok", distances: [dist], durations: [dist.map((d) => d / 10)] }));
  };
  fn.calls = calls;
  return fn;
}

test("parseStations tiene solo chi ha il carburante", () => {
  const s = parseStations(zone, "gpl", origin);
  assert.deepEqual(s.map((x) => x.id), ["1", "2"]);
  assert.equal(parseStations(zone, "benzina", origin).length, 1);
});

test("costo totale = pieno + andata", () => {
  const c = totalCost(0.8, 12, { litri: 30, consumo: 12 });
  assert.equal(c.fill.toFixed(2), "24.00");
  assert.equal(c.trip.toFixed(2), "0.80");
  assert.equal(c.total.toFixed(2), "24.80");
});

test("conviene il lontano economico e il messaggio lo dice", async () => {
  const f = fakeFetch();
  const settings = normalizeSettings(null);
  const r = await findBest(f, origin, settings);
  assert.equal(r.ranked[0].name, "Lontano");
  assert.equal(r.nearest.name, "Vicino");
  assert.equal(r.ranked[0].km, 6);
  const body = JSON.parse(f.calls[0].init.body);
  assert.equal(body.fuelType, "4-x");
  assert.equal(body.radius, 10);
  const text = buildReply(r, settings);
  assert.match(text, /🥇 <b>Lontano \(Esso\)<\/b>/);
  assert.match(text, /risparmi <b>2,\d\d €<\/b>/);
  assert.match(text, /google\.com\/maps\/dir/);
  console.log(text);
});

test("con pochi litri vince il vicino", async () => {
  const settings = normalizeSettings({ litri: 2, consumo: 5 });
  const r = await findBest(fakeFetch(), origin, settings);
  assert.equal(r.ranked[0].name, "Vicino");
  assert.match(buildReply(r, settings), /anche il più vicino/);
});

test("se OSRM non risponde usa la stima", async () => {
  const settings = normalizeSettings(null);
  const r = await findBest(fakeFetch({ osrmFails: true }), origin, settings);
  assert.equal(r.routed, false);
  assert.match(buildReply(r, settings), /distanze stimate/);
});

test("nessun risultato", () => {
  assert.match(buildReply({ ranked: [] }, normalizeSettings(null)), /Nessun distributore con GPL entro 10 km/);
});

test("comandi", () => {
  const s = normalizeSettings(null);
  assert.equal(applyCommand("/litri 40", s).settings.litri, 40);
  assert.equal(applyCommand("/consumo 9,5", s).settings.consumo, 9.5);
  assert.equal(applyCommand("/raggio 500", s).settings.raggio, DEFAULTS.raggio);
  assert.equal(applyCommand("/carburante benzina", s).settings.fuel, "benzina");
  assert.equal(applyCommand("/carburante diesel", s).settings.fuel, "gasolio");
  assert.ok(applyCommand("/carburante", s).fuelPicker);
  assert.equal(applyCommand("/litri@MioBot 25", s).settings.litri, 25);
  assert.equal(normalizeSettings({ fuel: "x", litri: -3 }).fuel, "gpl");
});

test("nomi in maiuscolo resi leggibili", () => {
  assert.equal(prettyName("SOCOGAS RETE  CUNEO OLMO PV 210310"), "Socogas Rete Cuneo Olmo Pv 210310");
  assert.equal(prettyName("Enercoop Cuneo"), "Enercoop Cuneo");
});
