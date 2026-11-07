// Cloudflare Worker: bot Telegram che, ricevuta una posizione, indica il
// distributore più conveniente contando anche il tragitto.
//
// Variabili (wrangler secret put ...):
//   TELEGRAM_BOT_TOKEN  token di @BotFather
//   WEBHOOK_SECRET      stringa casuale: protegge il webhook e la pagina /setup
// Binding facoltativo:
//   SETTINGS            namespace KV con le impostazioni di ogni utente

import { applyCommand, buildReply, findBest, FUELS, HELP, normalizeSettings } from "./logic.js";

const LOCATION_KEYBOARD = {
  keyboard: [[{ text: "📍 Invia la mia posizione", request_location: true }]],
  resize_keyboard: true,
};

const FUEL_PICKER = {
  inline_keyboard: [
    Object.entries(FUELS).map(([key, f]) => ({ text: f.label, callback_data: `fuel:${key}` })),
  ],
};

const NO_KV = "\n<i>(memoria impostazioni non configurata: vale solo per ora)</i>";

async function tg(env, method, params) {
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await resp.json().catch(() => ({}));
  if (!body.ok) console.log(`[telegram] ${method}: ${body.error_code} ${body.description}`);
  return body;
}

function send(env, chatId, text, extra = {}) {
  return tg(env, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...extra,
  });
}

async function loadSettings(env, userId) {
  if (!env.SETTINGS) return normalizeSettings(null);
  try {
    return normalizeSettings(await env.SETTINGS.get(`u:${userId}`, "json"));
  } catch {
    return normalizeSettings(null);
  }
}

async function saveSettings(env, userId, settings) {
  if (!env.SETTINGS) return false;
  await env.SETTINGS.put(`u:${userId}`, JSON.stringify(settings));
  return true;
}

async function handleLocation(env, msg, settings) {
  const chatId = msg.chat.id;
  const origin = { lat: msg.location.latitude, lng: msg.location.longitude };
  await tg(env, "sendChatAction", { chat_id: chatId, action: "find_location" });
  let text;
  try {
    const result = await findBest(fetch, origin, settings);
    text = buildReply(result, settings);
  } catch (err) {
    console.log(`[ricerca] ${err.stack || err}`);
    text = "⚠️ Non riesco a leggere i prezzi in questo momento. Riprova tra qualche minuto.";
  }
  await send(env, chatId, text, { reply_markup: LOCATION_KEYBOARD });
}

async function handleUpdate(env, update) {
  if (update.callback_query) {
    const q = update.callback_query;
    const key = String(q.data || "").replace(/^fuel:/, "");
    const settings = await loadSettings(env, q.from.id);
    const res = applyCommand(`/carburante ${key}`, settings);
    const saved = await saveSettings(env, q.from.id, res.settings);
    await tg(env, "answerCallbackQuery", { callback_query_id: q.id });
    if (q.message) {
      await send(env, q.message.chat.id, res.reply + (saved ? "" : NO_KV), { reply_markup: LOCATION_KEYBOARD });
    }
    return;
  }
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const userId = msg.from?.id ?? msg.chat.id;
  const settings = await loadSettings(env, userId);
  if (msg.location) return handleLocation(env, msg, settings);
  if (msg.venue?.location) return handleLocation(env, { ...msg, location: msg.venue.location }, settings);

  const res = typeof msg.text === "string" && msg.text.startsWith("/") ? applyCommand(msg.text, settings) : null;
  if (!res) {
    await send(env, msg.chat.id, HELP, { reply_markup: LOCATION_KEYBOARD });
    return;
  }
  let reply = res.reply;
  if (res.settings !== settings && !(await saveSettings(env, userId, res.settings))) reply += NO_KV;
  const markup = res.fuelPicker ? FUEL_PICKER : LOCATION_KEYBOARD;
  await send(env, msg.chat.id, reply, { reply_markup: markup });
}

async function setup(request, env) {
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("Non autorizzato", { status: 403 });
  const hook = `${url.origin}/webhook`;
  const res = await tg(env, "setWebhook", {
    url: hook,
    secret_token: env.WEBHOOK_SECRET,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
  await tg(env, "setMyCommands", {
    commands: [
      { command: "carburante", description: "Scegli il carburante" },
      { command: "litri", description: "Litri per rifornimento" },
      { command: "consumo", description: "Km percorsi con un litro" },
      { command: "raggio", description: "Distanza massima di ricerca (km)" },
      { command: "impostazioni", description: "Mostra le impostazioni" },
      { command: "aiuto", description: "Come funziona" },
    ],
  });
  const text = res.ok ? `Webhook attivo su ${hook}. Ora scrivi /start al bot.` : `Errore: ${res.description}`;
  return new Response(text, { status: res.ok ? 200 : 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!env.TELEGRAM_BOT_TOKEN || !env.WEBHOOK_SECRET) {
      return new Response("Mancano TELEGRAM_BOT_TOKEN o WEBHOOK_SECRET", { status: 500 });
    }
    if (url.pathname === "/setup") return setup(request, env);
    if (url.pathname === "/webhook" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Non autorizzato", { status: 403 });
      }
      const update = await request.json().catch(() => null);
      // Si risponde subito a Telegram (che altrimenti ripete l'invio) e si lavora dopo.
      if (update) ctx.waitUntil(handleUpdate(env, update).catch((err) => console.log(`[update] ${err.stack || err}`)));
      return new Response("ok");
    }
    return new Response("Bot distributore più conveniente: attivo.", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
