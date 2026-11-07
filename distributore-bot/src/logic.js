// Logica pura del bot: ricerca distributori, distanze, costo totale, messaggi.
// Nessuna dipendenza da Cloudflare, così si prova con `node --test`.

export const OSPZ_SEARCH_URL = "https://carburanti.mise.gov.it/ospzApi/search/zone";
export const OSRM_TABLE_URL = "https://router.project-osrm.org/table/v1/driving/";
const USER_AGENT = "Mozilla/5.0 (compatible; GPL-Monitor-Vicini/1.0)";

// Codici carburante dell'API Osservaprezzi: "<id>-x" = qualsiasi modalità (self o servito).
export const FUELS = {
  gpl: { label: "GPL", id: 4, match: (n) => n.includes("GPL") },
  benzina: { label: "Benzina", id: 1, match: (n) => n.startsWith("BENZINA") },
  gasolio: { label: "Gasolio", id: 2, match: (n) => n.startsWith("GASOLIO") || n.startsWith("DIESEL") },
  metano: { label: "Metano", id: 3, match: (n) => n.includes("METANO") },
};

export const DEFAULTS = {
  fuel: "gpl",
  litri: 30, // litri del rifornimento
  consumo: 12, // km percorsi con un litro
  raggio: 10, // km di ricerca
};

export const LIMITS = {
  litri: [1, 200],
  consumo: [2, 50],
  raggio: [1, 30],
};

const ROAD_FACTOR = 1.3; // stima strada/linea d'aria se il calcolo del percorso non risponde
const MAX_ROUTED = 25; // candidati per cui si chiede la distanza su strada
const TOP = 3;

// --------------------------------------------------------------------------- //
// Utilità
// --------------------------------------------------------------------------- //
export function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function htmlEscape(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const num = (v, digits) => v.toFixed(digits).replace(".", ",");
export const fmtPrice = (v) => num(v, 3);
export const fmtEuro = (v) => num(v, 2);
export const fmtKm = (v) => num(v, 1);

function toNumber(v) {
  const n = typeof v === "string" ? Number(v.replace(",", ".")) : Number(v);
  return Number.isFinite(n) ? n : null;
}

async function fetchJson(fetchFn, url, init = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers || {}) },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} da ${new URL(url).host}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------------------- //
// Distributori vicini (Osservaprezzi)
// --------------------------------------------------------------------------- //
/** Prezzo più basso del carburante scelto tra le voci di un impianto (self o servito). */
export function bestFuelPrice(fuels, fuelKey) {
  const fuel = FUELS[fuelKey];
  let best = null;
  for (const f of fuels || []) {
    if (!f || typeof f !== "object") continue;
    const name = String(f.name || "").toUpperCase();
    const byId = toNumber(f.fuelId) === fuel.id;
    if (!byId && !fuel.match(name)) continue;
    const price = toNumber(f.price);
    if (price === null || price <= 0.3 || price > 5) continue; // valori palesemente errati
    if (!best || price < best.price) best = { price, self: f.isSelf === true };
  }
  return best;
}

/** Converte la risposta di search/zone in una lista di distributori con prezzo. */
export function parseStations(data, fuelKey, origin) {
  const list = Array.isArray(data) ? data : data?.results || data?.data || [];
  const out = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const loc = r.location || {};
    const lat = toNumber(loc.lat ?? loc.latitude ?? r.lat ?? r.latitude);
    const lng = toNumber(loc.lng ?? loc.lon ?? loc.longitude ?? r.lng ?? r.lon ?? r.longitude);
    if (lat === null || lng === null) continue;
    const p = bestFuelPrice(r.fuels, fuelKey);
    if (!p) continue;
    out.push({
      id: String(r.id ?? ""),
      name: String(r.name || r.brand || "Distributore").trim(),
      brand: String(r.brand || "").trim(),
      address: String(r.address || "").trim(),
      lat,
      lng,
      price: p.price,
      self: p.self,
      date: r.insertDate || null,
      airKm: haversineKm(origin, { lat, lng }),
    });
  }
  return out;
}

export async function searchStations(fetchFn, origin, fuelKey, radiusKm) {
  const body = {
    points: [{ lat: origin.lat, lng: origin.lng }],
    radius: radiusKm,
    fuelType: `${FUELS[fuelKey].id}-x`,
    priceOrder: "asc",
  };
  const data = await fetchJson(fetchFn, OSPZ_SEARCH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseStations(data, fuelKey, origin).filter((s) => s.airKm <= radiusKm + 0.5);
}

// --------------------------------------------------------------------------- //
// Distanze su strada (OSRM, servizio pubblico gratuito)
// --------------------------------------------------------------------------- //
/** Restituisce [{km, min}] per ogni destinazione, null se non calcolabile. */
export async function roadDistances(fetchFn, origin, dests) {
  if (!dests.length) return [];
  const coords = [origin, ...dests].map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  const url = `${OSRM_TABLE_URL}${coords}?sources=0&annotations=distance,duration`;
  const data = await fetchJson(fetchFn, url, {}, 10000);
  const dist = data?.distances?.[0];
  const dur = data?.durations?.[0];
  if (data?.code !== "Ok" || !Array.isArray(dist)) throw new Error("risposta OSRM non valida");
  return dests.map((_, i) => {
    const m = dist[i + 1];
    return typeof m === "number" ? { km: m / 1000, min: (dur?.[i + 1] ?? 0) / 60 } : null;
  });
}

// --------------------------------------------------------------------------- //
// Costo totale e classifica
// --------------------------------------------------------------------------- //
/** Costo = pieno di `litri` + carburante bruciato per arrivare (solo andata). */
export function totalCost(price, km, settings) {
  const tripLiters = km / settings.consumo;
  return { fill: price * settings.litri, trip: price * tripLiters, total: price * (settings.litri + tripLiters) };
}

export async function findBest(fetchFn, origin, settings) {
  const stations = await searchStations(fetchFn, origin, settings.fuel, settings.raggio);
  if (!stations.length) return { ranked: [], routed: false, count: 0 };

  // Pre-selezione con la stima in linea d'aria, poi distanze vere sui migliori.
  const estimate = (s) => totalCost(s.price, s.airKm * ROAD_FACTOR, settings).total;
  const candidates = [...stations].sort((a, b) => estimate(a) - estimate(b)).slice(0, MAX_ROUTED);
  let routed = true;
  let roads = [];
  try {
    roads = await roadDistances(fetchFn, origin, candidates);
  } catch (err) {
    console.log(`[osrm] ${err.message}`);
    routed = false;
  }
  for (const [i, s] of candidates.entries()) {
    const road = roads[i];
    s.km = road ? road.km : s.airKm * ROAD_FACTOR;
    s.min = road ? road.min : null;
    s.estimated = !road;
    Object.assign(s, totalCost(s.price, s.km, settings));
  }
  const ranked = candidates.sort((a, b) => a.total - b.total || a.km - b.km);
  const nearest = [...candidates].sort((a, b) => a.km - b.km)[0];
  return { ranked, nearest, routed, count: stations.length };
}

// --------------------------------------------------------------------------- //
// Messaggi
// --------------------------------------------------------------------------- //
export function mapsLink(s) {
  return `https://www.google.com/maps/dir/?api=1&destination=${s.lat.toFixed(6)},${s.lng.toFixed(6)}`;
}

export function settingsLine(settings) {
  return (
    `${FUELS[settings.fuel].label} · pieno ${settings.litri} l · ${settings.consumo} km/l · ` +
    `raggio ${settings.raggio} km`
  );
}

export function buildReply(result, settings) {
  const fuel = FUELS[settings.fuel].label;
  if (!result.ranked.length) {
    return (
      `😕 Nessun distributore con ${fuel} entro ${settings.raggio} km.\n` +
      `Prova ad allargare il raggio, ad esempio /raggio ${Math.min(settings.raggio * 2, LIMITS.raggio[1])}.`
    );
  }
  const medals = ["🥇", "🥈", "🥉"];
  const top = result.ranked.slice(0, TOP);
  const lines = [`⛽ <b>Dove conviene fare ${fuel}</b>`, `<i>${htmlEscape(settingsLine(settings))}</i>`];
  top.forEach((s, i) => {
    const time = s.min ? ` · ${Math.max(1, Math.round(s.min))} min` : "";
    const approx = s.estimated ? "≈ " : "";
    const label = s.brand && !s.name.toUpperCase().includes(s.brand.toUpperCase()) ? `${s.name} (${s.brand})` : s.name;
    let block =
      `${medals[i]} <b>${htmlEscape(label)}</b>\n` +
      `      <b>${fmtEuro(s.total)} €</b> totali · ${fmtPrice(s.price)} €/l\n` +
      `      ${approx}${fmtKm(s.km)} km${time} · viaggio ${fmtEuro(s.trip)} €`;
    if (i > 0) block += ` · +${fmtEuro(s.total - top[0].total)} €`;
    if (s.address) block += `\n      <i>${htmlEscape(s.address)}</i>`;
    block += `\n      <a href="${mapsLink(s)}">Portami qui</a>`;
    lines.push(block);
  });
  const best = top[0];
  const near = result.nearest;
  if (near && near !== best) {
    const saved = near.total - best.total;
    if (saved > 0.005) {
      lines.push(
        `💡 Rispetto al più vicino (${htmlEscape(near.name)}, ${fmtKm(near.km)} km, ${fmtPrice(near.price)} €/l) ` +
          `risparmi <b>${fmtEuro(saved)} €</b>.`
      );
    }
  } else if (near === best) {
    lines.push("💡 Il più conveniente è anche il più vicino.");
  }
  if (!result.routed) lines.push("<i>≈ distanze stimate: il calcolo del percorso non ha risposto.</i>");
  return lines.join("\n\n");
}

export const HELP =
  "📍 Mandami la tua <b>posizione</b> (graffetta → Posizione, oppure il pulsante qui sotto) " +
  "e ti dico in quale distributore vicino conviene fare rifornimento, contando anche " +
  "il carburante che consumi per arrivarci.\n\n" +
  "<b>Impostazioni</b>\n" +
  "/carburante – GPL, benzina, gasolio o metano\n" +
  "/litri 30 – quanti litri metti a ogni rifornimento\n" +
  "/consumo 12 – km che fai con un litro\n" +
  "/raggio 10 – distanza massima di ricerca in km\n" +
  "/impostazioni – mostra quelle attuali";

/** Interpreta un comando di impostazione. Restituisce {settings, reply} o null. */
export function applyCommand(text, settings) {
  const m = String(text || "").trim().match(/^\/(\w+)(?:@\w+)?(?:\s+(.+))?$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const arg = (m[2] || "").trim();
  const next = { ...settings };
  if (cmd === "start" || cmd === "help" || cmd === "aiuto") return { settings, reply: HELP, keyboard: true };
  if (cmd === "impostazioni") return { settings, reply: `⚙️ ${htmlEscape(settingsLine(settings))}` };
  if (cmd === "carburante") {
    const key = arg.toLowerCase().replace("diesel", "gasolio");
    if (!FUELS[key]) {
      return { settings, reply: "Quale carburante?", fuelPicker: true };
    }
    next.fuel = key;
    return { settings: next, reply: `✅ Carburante: <b>${FUELS[key].label}</b>`, keyboard: true };
  }
  if (cmd in LIMITS) {
    const [lo, hi] = LIMITS[cmd];
    const value = toNumber(arg);
    const unit = { litri: "litri", consumo: "km/l", raggio: "km" }[cmd];
    if (value === null || value < lo || value > hi) {
      return { settings, reply: `Scrivi un numero tra ${lo} e ${hi}, ad esempio /${cmd} ${DEFAULTS[cmd]} (ora: ${settings[cmd]} ${unit}).` };
    }
    next[cmd] = Math.round(value * 10) / 10;
    return { settings: next, reply: `✅ ${cmd[0].toUpperCase() + cmd.slice(1)}: <b>${next[cmd]} ${unit}</b>` };
  }
  return { settings, reply: HELP, keyboard: true };
}

export function normalizeSettings(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  if (!FUELS[s.fuel]) s.fuel = DEFAULTS.fuel;
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = toNumber(s[k]);
    s[k] = v === null || v < lo || v > hi ? DEFAULTS[k] : v;
  }
  return s;
}
