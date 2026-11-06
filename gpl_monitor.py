#!/usr/bin/env python3
"""GPL Monitor: invia su Telegram il prezzo del GPL nei distributori scelti.

Fonte dati: Osservaprezzi Carburanti del MIMIT (open data).
  - Prezzo più recente: API pubblica usata dal sito ufficiale
    (carburanti.mise.gov.it/ospzApi/registry/servicearea/<id>)
  - Ripiego: CSV giornaliero "prezzo_alle_8.csv"

Uso:
  python gpl_monitor.py                  # invia il messaggio su Telegram
  python gpl_monitor.py --dry-run        # stampa il messaggio senza inviarlo
  python gpl_monitor.py --find "beinette" [--provincia CN]
                                         # cerca un distributore nell'anagrafica

Variabili d'ambiente richieste per l'invio:
  TELEGRAM_BOT_TOKEN  token del bot (@BotFather)
  TELEGRAM_CHAT_ID    destinatario: "@nomecanale" per un canale pubblico
                      (il bot deve esserne amministratore) o un chat id numerico
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE_CSV = "https://www.mimit.gov.it/images/exportCSV/"
ANAGRAFICA_URL = BASE_CSV + "anagrafica_impianti_attivi.csv"
PREZZI_URL = BASE_CSV + "prezzo_alle_8.csv"
API_URL = "https://carburanti.mise.gov.it/ospzApi/registry/servicearea/{id}"
STATIONS_FILE = Path(__file__).with_name("stations.json")
USER_AGENT = "Mozilla/5.0 (compatible; GPL-Monitor/1.0)"


# --------------------------------------------------------------------------- #
# Download e parsing
# --------------------------------------------------------------------------- #
def http_get(url: str, retries: int = 3, timeout: int = 60) -> bytes:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"Download fallito per {url}: {last}")


def read_mimit_csv(url: str, retries: int = 3, timeout: int = 60) -> list[dict[str, str]]:
    """Legge un CSV MIMIT: prima riga 'Estrazione del ...', poi intestazione.

    Il separatore è cambiato nel tempo (';' oppure '|'), quindi lo rileviamo.
    """
    text = http_get(url, retries=retries, timeout=timeout).decode("utf-8", errors="replace")
    lines = text.splitlines()
    if lines and lines[0].lower().startswith("estrazione"):
        lines = lines[1:]
    if not lines:
        return []
    header = lines[0]
    delimiter = "|" if header.count("|") > header.count(";") else ";"
    # QUOTE_NONE: nei nomi/indirizzi compaiono virgolette non bilanciate.
    reader = csv.reader(
        io.StringIO("\n".join(lines)), delimiter=delimiter, quoting=csv.QUOTE_NONE
    )
    keys = [k.strip() for k in next(reader)]
    rows = []
    for fields in reader:
        if not fields:
            continue
        if len(fields) > len(keys):
            # Separatore presente dentro un campo testuale: lo riaccorpiamo
            # nell'ultimo campo testuale prima delle colonne finali fisse.
            extra = len(fields) - len(keys)
            tail = 2 if "Latitudine" in keys else 0
            cut = len(fields) - tail - extra - 1
            fields = fields[:cut] + [delimiter.join(fields[cut:cut + extra + 1])] + fields[cut + extra + 1:]
        rows.append({k: (v or "").strip() for k, v in zip(keys, fields)})
    return rows


def norm(s: str) -> str:
    return " ".join(
        "".join(c if c.isalnum() else " " for c in s.upper()).split()
    )


# --------------------------------------------------------------------------- #
# Prezzi
# --------------------------------------------------------------------------- #
def is_gpl(name: str) -> bool:
    return "GPL" in name.upper()


try:
    from zoneinfo import ZoneInfo

    ROME = ZoneInfo("Europe/Rome")
except Exception:  # noqa: BLE001  (es. Windows senza pacchetto tzdata)
    ROME = None


def to_rome(dt: datetime) -> datetime:
    """Converte un datetime UTC in ora italiana (naive)."""
    dt = dt.replace(tzinfo=timezone.utc)
    return (dt.astimezone(ROME) if ROME else dt.astimezone()).replace(tzinfo=None)


def parse_date(value: str) -> datetime | None:
    """Restituisce l'ora italiana. L'API usa UTC ('...Z'), il CSV l'ora locale."""
    if not value:
        return None
    for fmt, is_utc in (
        ("%Y-%m-%dT%H:%M:%S.%fZ", True),
        ("%Y-%m-%dT%H:%M:%SZ", True),
        ("%Y-%m-%dT%H:%M:%S", False),
        ("%d/%m/%Y %H:%M:%S", False),
        ("%d/%m/%Y %H:%M", False),
    ):
        try:
            dt = datetime.strptime(value, fmt)
        except ValueError:
            continue
        return to_rome(dt) if is_utc else dt
    return None


def price_from_api(station_id: str) -> dict | None:
    """Prezzo GPL più recente dall'API Osservaprezzi (aggiornata in tempo reale)."""
    try:
        data = json.loads(http_get(API_URL.format(id=station_id), retries=2, timeout=30))
    except Exception as exc:  # noqa: BLE001
        print(f"[api] impianto {station_id}: {exc}", file=sys.stderr)
        return None
    best = None
    for fuel in data.get("fuels") or []:
        if not is_gpl(str(fuel.get("name", ""))):
            continue
        when = parse_date(str(fuel.get("insertDate") or fuel.get("validityDate") or ""))
        cand = {"price": float(fuel["price"]), "date": when}
        if best is None or (when and (best["date"] is None or when > best["date"])):
            best = cand
    if best:
        best["name"] = data.get("name") or ""
        best["address"] = data.get("address") or ""
    return best


def prices_from_csv() -> dict[str, dict]:
    """Prezzi GPL dal CSV giornaliero, indicizzati per idImpianto."""
    out: dict[str, dict] = {}
    # Ripiego: timeout breve e un solo tentativo (da GitHub Actions il sito
    # www.mimit.gov.it spesso non risponde, inutile sprecare minuti).
    for row in read_mimit_csv(PREZZI_URL, retries=1, timeout=20):
        if not is_gpl(row.get("descCarburante", "")):
            continue
        sid = row.get("idImpianto", "")
        try:
            price = float(row.get("prezzo", "").replace(",", "."))
        except ValueError:
            continue
        when = parse_date(row.get("dtComu", ""))
        cur = out.get(sid)
        if cur is None or (when and (cur["date"] is None or when > cur["date"])):
            out[sid] = {"price": price, "date": when}
    return out


# --------------------------------------------------------------------------- #
# Messaggio Telegram
# --------------------------------------------------------------------------- #
def html_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_message(results: list[tuple[dict, dict | None]]) -> str:
    """Messaggio nell'ordine di stations.json.

    🟢 prezzo più basso, 🔴 prezzo più alto, 🟡 gli altri (a parità di prezzo
    il pallino è lo stesso; se tutti i prezzi coincidono sono tutti verdi).
    """
    today = to_rome(datetime.now(timezone.utc).replace(tzinfo=None)).strftime("%d/%m/%Y")
    lines = [f"⛽ <b>Prezzi GPL – {today}</b>", ""]
    prices = [p["price"] for _, p in results if p]
    best = min(prices) if prices else None
    worst = max(prices) if prices else None
    for station, p in results:
        name = html_escape(station["label"])
        if not p:
            lines.append(f"⚪ <b>{name}</b>\n    prezzo non disponibile")
            continue
        if p["price"] == best:
            mark = "🟢"
        elif p["price"] == worst:
            mark = "🔴"
        else:
            mark = "🟡"
        price = f"{p['price']:.3f}".replace(".", ",")
        date = p["date"].strftime("%d/%m %H:%M") if p["date"] else "n.d."
        lines.append(
            f"{mark} <b>{name}</b>: {price} €/l\n"
            f"    <i>aggiornato il {date}</i>"
        )
    return "\n".join(lines)



# --------------------------------------------------------------------------- #
# Telegram
# --------------------------------------------------------------------------- #
class TelegramError(Exception):
    def __init__(self, code: int, description: str):
        super().__init__(f"{code}: {description}")
        self.code = code
        self.description = description


def tg(method: str, **params) -> object:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        sys.exit("Manca la variabile d'ambiente TELEGRAM_BOT_TOKEN.")
    data = urllib.parse.urlencode(
        {k: v if isinstance(v, str) else json.dumps(v) for k, v in params.items()}
    ).encode()
    url = f"https://api.telegram.org/bot{token}/{method}"
    for _ in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=30) as r:
                body = json.loads(r.read())
        except urllib.error.HTTPError as exc:
            try:
                body = json.loads(exc.read())
            except Exception:  # noqa: BLE001
                body = {"ok": False, "error_code": exc.code, "description": str(exc)}
        if body.get("ok"):
            return body.get("result")
        retry = (body.get("parameters") or {}).get("retry_after")
        if body.get("error_code") == 429 and retry:
            time.sleep(int(retry) + 1)
            continue
        break
    raise TelegramError(int(body.get("error_code") or 0), str(body.get("description")))


def send_message(chat_id: int | str, text: str) -> None:
    tg("sendMessage", chat_id=str(chat_id), text=text, parse_mode="HTML",
       disable_web_page_preview="true")


# --------------------------------------------------------------------------- #
# Prezzi -> messaggio
# --------------------------------------------------------------------------- #
def current_message() -> str:
    stations = json.loads(STATIONS_FILE.read_text(encoding="utf-8"))
    csv_prices: dict[str, dict] | None = None
    results: list[tuple[dict, dict | None]] = []
    for st in stations:
        sid = str(st["id"])
        p = price_from_api(sid)
        if p is None:
            if csv_prices is None:
                try:
                    csv_prices = prices_from_csv()
                except Exception as exc:  # noqa: BLE001
                    print(f"[csv] {exc}", file=sys.stderr)
                    csv_prices = {}
            p = csv_prices.get(sid)
        results.append((st, p))
    return build_message(results)


# --------------------------------------------------------------------------- #
# Comandi
# --------------------------------------------------------------------------- #
def cmd_find(queries: list[str], provincia: str | None) -> None:
    rows = read_mimit_csv(ANAGRAFICA_URL)
    try:
        gpl = prices_from_csv()
    except Exception as exc:  # noqa: BLE001
        print(f"[csv] {exc}", file=sys.stderr)
        gpl = {}
    for q in queries:
        words = norm(q).split()
        print(f"\n=== {q} ===")
        scored = []
        for r in rows:
            if provincia and r.get("Provincia", "").upper() != provincia.upper():
                continue
            hay = norm(" ".join(r.values()))
            score = sum(1 for w in words if w in hay.split() or w in hay)
            if score:
                scored.append((score, r))
        scored.sort(key=lambda x: -x[0])
        for score, r in scored[:8]:
            p = gpl.get(r.get("idImpianto", ""))
            tag = f"GPL {p['price']:.3f}" if p else "no GPL"
            print(
                f"  [{score}/{len(words)}] id={r.get('idImpianto')} [{tag}] | "
                f"{r.get('Nome Impianto')} | {r.get('Bandiera')} | "
                f"{r.get('Gestore')} | {r.get('Indirizzo')} | {r.get('Comune')}"
            )



def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="stampa il messaggio senza inviarlo")
    ap.add_argument("--find", nargs="+", metavar="TESTO", help="cerca distributori nell'anagrafica")
    ap.add_argument("--provincia", help="filtra la ricerca per sigla provincia (es. CN)")
    args = ap.parse_args()
    if args.find:
        cmd_find(args.find, args.provincia)
        return
    text = current_message()
    print(text)
    if not args.dry_run:
        chat_id = os.environ.get("TELEGRAM_CHAT_ID")
        if not chat_id:
            sys.exit("Manca la variabile d'ambiente TELEGRAM_CHAT_ID.")
        try:
            send_message(chat_id, text)
        except TelegramError as exc:
            sys.exit(f"Errore Telegram {exc}")
        print("Messaggio inviato su Telegram.")


if __name__ == "__main__":
    main()
