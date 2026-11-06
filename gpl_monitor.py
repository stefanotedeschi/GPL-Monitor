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
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
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
from datetime import datetime
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


def read_mimit_csv(url: str) -> list[dict[str, str]]:
    """Legge un CSV MIMIT: prima riga 'Estrazione del ...', poi intestazione.

    Il separatore è cambiato nel tempo (';' oppure '|'), quindi lo rileviamo.
    """
    text = http_get(url).decode("utf-8", errors="replace")
    lines = text.splitlines()
    if lines and lines[0].lower().startswith("estrazione"):
        lines = lines[1:]
    header = lines[0] if lines else ""
    delimiter = "|" if header.count("|") > header.count(";") else ";"
    reader = csv.DictReader(io.StringIO("\n".join(lines)), delimiter=delimiter)
    rows = []
    for row in reader:
        rows.append({(k or "").strip(): (v or "").strip() for k, v in row.items()})
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


def parse_date(value: str) -> datetime | None:
    if not value:
        return None
    for fmt in (
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S",
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
    ):
        try:
            return datetime.strptime(value, fmt)
        except ValueError:
            continue
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
    for row in read_mimit_csv(PREZZI_URL):
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
    today = datetime.now().strftime("%d/%m/%Y")
    lines = [f"⛽ <b>Prezzi GPL – {today}</b>", ""]
    found = sorted(
        [(s, p) for s, p in results if p], key=lambda sp: sp[1]["price"]
    )
    missing = [s for s, p in results if not p]
    cheapest = found[0][1]["price"] if found else None
    for station, p in found:
        mark = "🟢 " if p["price"] == cheapest else "• "
        date = p["date"].strftime("%d/%m %H:%M") if p["date"] else "n.d."
        lines.append(
            f"{mark}<b>{p['price']:.3f} €/l</b> – {html_escape(station['label'])}\n"
            f"    <i>aggiornato il {date}</i>"
        )
    for station in missing:
        lines.append(f"⚠️ {html_escape(station['label'])}: prezzo non disponibile")
    return "\n".join(lines)


def send_telegram(text: str) -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        sys.exit("Mancano TELEGRAM_BOT_TOKEN e/o TELEGRAM_CHAT_ID.")
    payload = urllib.parse.urlencode(
        {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": "true",
        }
    ).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage", data=payload
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        sys.exit(f"Errore Telegram {exc.code}: {exc.read().decode(errors='replace')}")
    if not body.get("ok"):
        sys.exit(f"Errore Telegram: {body}")


# --------------------------------------------------------------------------- #
# Comandi
# --------------------------------------------------------------------------- #
def cmd_find(queries: list[str], provincia: str | None) -> None:
    rows = read_mimit_csv(ANAGRAFICA_URL)
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
            print(
                f"  [{score}/{len(words)}] id={r.get('idImpianto')} | "
                f"{r.get('Nome Impianto')} | {r.get('Bandiera')} | "
                f"{r.get('Gestore')} | {r.get('Indirizzo')} | {r.get('Comune')}"
            )


def cmd_run(dry_run: bool) -> None:
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
    text = build_message(results)
    print(text)
    if not dry_run:
        send_telegram(text)
        print("\nMessaggio inviato su Telegram.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="non inviare su Telegram")
    ap.add_argument("--find", nargs="+", metavar="TESTO", help="cerca distributori nell'anagrafica")
    ap.add_argument("--provincia", help="filtra la ricerca per sigla provincia (es. CN)")
    args = ap.parse_args()
    if args.find:
        cmd_find(args.find, args.provincia)
    else:
        cmd_run(args.dry_run)


if __name__ == "__main__":
    main()
