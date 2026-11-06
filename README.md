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

Il workflow `.github/workflows/gpl-daily.yml` è pianificato alle 7 e alle 8
UTC; un controllo fa proseguire solo quello che corrisponde alle 9 a Roma
(07 UTC con l'ora legale, 08 UTC con l'ora solare), così non ci sono doppi
invii. GitHub può avviare i job pianificati con qualche minuto di ritardo.
Dopo 60 giorni senza commit GitHub sospende i workflow pianificati: si
riattivano con *Enable workflow*.

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
