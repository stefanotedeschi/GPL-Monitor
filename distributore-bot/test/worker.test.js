import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/worker.js";

const SECRET = "s3greto";

function makeEnv() {
  const store = new Map();
  return {
    TELEGRAM_BOT_TOKEN: "123:abc",
    WEBHOOK_SECRET: SECRET,
    SETTINGS: {
      get: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null),
      put: async (k, v) => store.set(k, v),
    },
    store,
  };
}

function mockFetch() {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.includes("api.telegram.org")) {
      sent.push({ method: url.split("/").pop(), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }
    if (url.includes("ospzApi")) {
      return new Response(JSON.stringify({ results: [
        { id: 9, name: "Stazione", address: "Via X", location: { lat: 44.39, lng: 7.55 }, fuels: [{ fuelId: 4, name: "GPL", price: 0.75 }] },
      ] }));
    }
    return new Response(JSON.stringify({ code: "Ok", distances: [[0, 2500]], durations: [[0, 240]] }));
  };
  return sent;
}

async function post(env, update, secret = SECRET) {
  const waits = [];
  const res = await worker.fetch(
    new Request("https://bot.example.workers.dev/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "Content-Type": "application/json" },
      body: JSON.stringify(update),
    }),
    env,
    { waitUntil: (p) => waits.push(p) },
  );
  await Promise.all(waits);
  return res;
}

const msg = (extra) => ({ message: { message_id: 1, chat: { id: 77 }, from: { id: 77 }, ...extra } });

test("rifiuta webhook senza segreto", async () => {
  mockFetch();
  const res = await post(makeEnv(), msg({ text: "/start" }), "sbagliato");
  assert.equal(res.status, 403);
});

test("posizione -> risposta con il distributore", async () => {
  const sent = mockFetch();
  const res = await post(makeEnv(), msg({ location: { latitude: 44.3845, longitude: 7.5427 } }));
  assert.equal(res.status, 200);
  const reply = sent.find((s) => s.method === "sendMessage");
  assert.match(reply.body.text, /🥇 <b>Stazione<\/b>/);
  assert.match(reply.body.text, /2,5 km · 4 min/);
});

test("le impostazioni vengono salvate e usate", async () => {
  const sent = mockFetch();
  const env = makeEnv();
  await post(env, msg({ text: "/litri 40" }));
  assert.equal(JSON.parse(env.store.get("u:77")).litri, 40);
  await post(env, msg({ location: { latitude: 44.3845, longitude: 7.5427 } }));
  assert.match(sent.at(-1).body.text, /pieno 40 l/);
});

test("scelta carburante dai pulsanti", async () => {
  const sent = mockFetch();
  const env = makeEnv();
  await post(env, { callback_query: { id: "q", from: { id: 77 }, data: "fuel:metano", message: { chat: { id: 77 } } } });
  assert.equal(JSON.parse(env.store.get("u:77")).fuel, "metano");
  assert.match(sent.at(-1).body.text, /Metano/);
});

test("/setup protetto dalla chiave", async () => {
  const sent = mockFetch();
  const env = makeEnv();
  const bad = await worker.fetch(new Request("https://b.dev/setup?key=no"), env, {});
  assert.equal(bad.status, 403);
  const ok = await worker.fetch(new Request(`https://b.dev/setup?key=${SECRET}`), env, {});
  assert.equal(ok.status, 200);
  assert.equal(sent[0].body.url, "https://b.dev/webhook");
  assert.equal(sent[0].body.secret_token, SECRET);
});
