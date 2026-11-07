# Bot distributore più conveniente

Mandi al bot la tua **posizione** su Telegram e lui ti dice in quale distributore
vicino conviene fare rifornimento, contando sia il prezzo sia il carburante che
consumi per arrivarci.

**Costo totale = prezzo × (litri del pieno + km di andata ÷ consumo)**

Risponde con i 3 più convenienti, il costo totale, i km e i minuti su strada,
quanto risparmi rispetto al distributore più vicino e un link *Portami qui* a
Google Maps.

- Prezzi: API Osservaprezzi Carburanti del MIMIT (`ospzApi/search/zone`), la
  stessa fonte del bot GPL giornaliero.
- Distanze su strada: servizio pubblico gratuito OSRM. Se non risponde il bot usa
  una stima dalla linea d'aria e lo scrive nel messaggio.
- Gira come **Cloudflare Worker** (piano gratuito): sempre attivo, Telegram lo
  chiama via webhook solo quando arriva un messaggio.

## Comandi

| Comando | Effetto | Predefinito |
|---|---|---|
| posizione 📍 | cerca i distributori | |
| `/carburante` | GPL, benzina, gasolio o metano (pulsanti) | GPL |
| `/litri 30` | litri per rifornimento | 30 |
| `/consumo 12` | km fatti con un litro | 12 |
| `/raggio 10` | distanza massima di ricerca (km, max 30) | 10 |
| `/impostazioni` | mostra le impostazioni | |

Le impostazioni sono salvate per ogni utente (Cloudflare KV).

## Installazione

Serve [Node.js](https://nodejs.org) (versione 20 o successiva) sul PC.

1. **Nuovo bot**: su Telegram, con @BotFather `/newbot`, copia il token. Usa un
   bot diverso da quello del canale GPL.
2. **Account Cloudflare**: registrati gratis su <https://dash.cloudflare.com/sign-up>.
3. Dal prompt, nella cartella `distributore-bot`:

   ```bash
   npm install
   npx wrangler login                       # si apre il browser per autorizzare
   npx wrangler deploy                      # crea il worker e lo spazio impostazioni
   npx wrangler secret put TELEGRAM_BOT_TOKEN   # incolla il token
   npx wrangler secret put WEBHOOK_SECRET       # inventa una parola lunga, solo lettere e numeri
   ```

   `deploy` stampa l'indirizzo del worker, ad esempio
   `https://distributore-bot.<tuonome>.workers.dev`.
4. **Collega Telegram**: apri nel browser
   `https://distributore-bot.<tuonome>.workers.dev/setup?key=<WEBHOOK_SECRET>`.
   Deve comparire *Webhook attivo*.
5. Scrivi `/start` al bot e premi **📍 Invia la mia posizione**.

Per aggiornare dopo una modifica al codice basta `npx wrangler deploy`.
I log si vedono con `npx wrangler tail` o nella dashboard Cloudflare.

Il token resta solo nei secret di Cloudflare. Se finisce in giro: `/revoke` in
@BotFather, `npx wrangler secret put TELEGRAM_BOT_TOKEN` e di nuovo `/setup`.

## Sviluppo

```bash
npm test                             # prove con dati finti
node test/live.mjs 44.38 7.54 gpl    # prova con le API vere (lat, lng, carburante)
```

Il workflow `Bot distributore - prove` esegue entrambe le prove a ogni modifica
della cartella.
