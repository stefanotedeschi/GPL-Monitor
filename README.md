# GPL-Monitor

Ogni mattina alle 9 (ora italiana) un bot Telegram pubblica in un **canale
pubblico** il prezzo GPL più recente dei distributori in `stations.json`,
usando gli open data MIMIT Osservaprezzi Carburanti. Chiunque può iscriversi
al canale e ricevere il messaggio. Solo libreria standard Python, gira su
GitHub Actions senza server.

## Configurazione

1. **Bot** – su Telegram crea un bot con @BotFather (`/newbot`) e copia il token.
2. **Canale** – su Telegram: *Nuovo canale* → tipo **pubblico** → scegli il
   link, es. `t.me/prezzigplcuneo`.
3. **Bot amministratore** – nel canale: *Amministratori → Aggiungi
   amministratore* → cerca il bot → lascia attivo il permesso
   **Pubblica messaggi**.
4. **Secret GitHub** – nel repo: *Settings → Secrets and variables → Actions →
   New repository secret*:
   - `TELEGRAM_BOT_TOKEN` = token di @BotFather
   - `TELEGRAM_CHAT_ID` = `@nomecanale` (es. `@prezzigplcuneo`)
5. **Prova** – *Actions → GPL giornaliero → Run workflow*: il messaggio
   compare subito nel canale.

Il token va solo nei secret, mai nel codice. Se finisce in giro, in @BotFather
usa `/revoke` e aggiorna il secret.

## Funzionamento

Il workflow `.github/workflows/gpl-daily.yml` è pianificato alle 7:05, 8:05,
9:05 e 10:05 UTC. Lo script invia al primo avvio dalle 9 di Roma in poi e salta
gli altri se il messaggio del giorno è già partito: così un avvio saltato o in
ritardo di GitHub (capita, soprattutto allo scoccare dell'ora) viene recuperato
dal tentativo successivo, senza doppi invii. Dopo 60 giorni senza commit GitHub
sospende i workflow pianificati: si riattivano con *Enable workflow*.

### Avvio esterno (più affidabile del cron di GitHub)

Il cron di GitHub è "best effort" e può saltare. Per un orario sicuro si può
far avviare il workflow da un servizio esterno, ad esempio
[cron-job.org](https://cron-job.org) (gratuito):

1. GitHub → *Settings → Developer settings → Fine-grained tokens → Generate
   new token*: solo il repository `GPL-Monitor`, permesso **Actions: Read and
   write**, scadenza a scelta.
2. Su cron-job.org crea un job alle **9:00, fuso Europe/Rome**:
   - URL `https://api.github.com/repos/stefanotedeschi/GPL-Monitor/actions/workflows/gpl-daily.yml/dispatches`
   - metodo **POST**
   - header `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`
   - corpo `{"ref":"main","inputs":{"programmato":"true"}}`

Con `programmato=true` il workflow si comporta come l'invio programmato: un
solo messaggio al giorno e frecce aggiornate. Il cron di GitHub resta come
riserva e salta l'invio se è già partito.

I prezzi arrivano dall'API Osservaprezzi (`carburanti.mise.gov.it/ospzApi`).
Il CSV `prezzo_alle_8.csv` è solo un ripiego, con timeout breve perché da
GitHub Actions `www.mimit.gov.it` non risponde.

## Simboli nel messaggio

- 📍 sezione (campo `zona`)
- 🟢 prezzo più basso, 🔴 più alto, 🟡 gli altri, confrontati dentro il gruppo
  `confronto` (o della zona se manca)
- ▲ / ▼ variazione rispetto all'invio programmato del giorno prima (salvato
  nella cache di GitHub Actions; le esecuzioni manuali non lo aggiornano)
- ⏳ prezzo in vigore da più di 7 giorni: potrebbe non essere aggiornato

## Uso locale

```bash
python gpl_monitor.py --dry-run                        # stampa il messaggio
python gpl_monitor.py --provincia CN --find "beinette" # cerca un impianto
```

Per un invio di prova impostare `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`
come variabili d'ambiente e lanciare `python gpl_monitor.py`.

## Distributori

`stations.json` è una lista di
`{"id": "<idImpianto>", "label": "<nome>", "zona": "<sezione>"}`, con
`"confronto": "<zona>"` facoltativo per confrontare i prezzi insieme a
un'altra zona (es. Mondovì con Cuneo). Le sezioni seguono l'ordine del file.
L'`idImpianto` si trova con `--find`, che indica anche se l'impianto vende GPL.

## Altro bot: distributore più conveniente

Nella cartella [`distributore-bot`](distributore-bot/README.md) c'è un secondo
bot, interattivo: gli mandi la tua posizione e ti dice dove conviene fare
rifornimento contando anche il tragitto.
