"""Turn a Zepto Sales_F export into rows for the "SALES DATA-Zepto" tab.

The sheet's schema is not the portal's. The tab is 15 columns wide, A..O, and
only Date, EAN, Qty, Sale Value and City come from the report itself:

    Listing Sku Code, Size   <- "EAN OMS Mapping"
    Zone                     <- "Zone Mapping"
    Catalog Name+Color       <- "Master Sheet-OMS"
    Channel Name             <- the same constant on every row
    Month (A), Category (F)  <- written as the sheet's own formulas, so the tab
                                keeps computing them the way it always has
    Week NUm, Month, Year    <- derived from Date

This module does those lookups and emits rows in the sheet's column order and
types. Column H, Sale Value, is the report's "Gross Selling Value".

The sheet is read before anything is downloaded, so the request covers whichever
days are actually absent rather than a fixed window: if the job does not run for
a while — the PC was off, the portal was down — the next run asks for everything
back to the oldest missing day and fills the gap. Nothing has to be caught up by
hand.

The lookup tabs are read through the Sheets API, with each tab's header row
stated in HEADER_ROW rather than guessed.

    python sheet_pipeline.py --from-portal      fetch what's missing and append
    python sheet_pipeline.py --dry-run          preview the rows to append
    python sheet_pipeline.py --days 30          look further back for gaps
"""

import argparse
import datetime as dt
import io
import sys

import pandas as pd

import config

DATA_TAB = "SALES DATA-Zepto"

# Read from .env rather than hard-coded: the workbook is readable by anyone with
# the link, so publishing its id would publish the sales data with it.
SHEET_ID = config.GSHEET_ID
if not SHEET_ID:
    raise SystemExit("GSHEET_ID is not set in .env — see .env.example.")

# Column order of the destination tab, A..O. The tab has two columns headed
# "Month" — A is the "08'2026" text stamp, N the plain month number — so the
# second is carried under a distinct internal name and only the position counts.
COLUMNS = [
    "Month",               # A  formula
    "Date",                # B
    "Listing Sku Code",    # C
    "EAN",                 # D
    "Channel Name",        # E  constant
    "Category",            # F  formula
    "Qty",                 # G
    "Sale Value",          # H
    "Catalog Name+Color",  # I
    "Size",                # J
    "City",                # K
    "Zone",                # L
    "Week NUm",            # M
    "Month Num",           # N
    "Year",                # O
]
FIRST_COL, LAST_COL = "A", "O"

# A and F are the sheet's own lookups, not ours: they are re-laid as formulas on
# every appended row, exactly as they read in the rows already there, so the tab
# keeps computing them itself. {row} is the 1-based sheet row.
FORMULAS = {
    "Month": """=TEXT(B{row},"mm'yyyy")""",
    "Category": "=VLOOKUP(C{row},'EAN OMS Mapping'!B:D,3,0)",
}

# Every row in the tab carries the same channel.
CHANNEL_NAME = "VB EXPORT - Zepto"

# The Sales_F column that feeds "Sale Value" (H).
GSV_COLUMN = "Gross Selling Value"

# These are numbers in the sheet, not text — keep them that way on write.
NUMERIC = {"Qty", "Week NUm", "Month Num", "Year", "EAN"}
# Money: kept numeric too, but not forced to a whole number.
DECIMAL = {"Sale Value"}

SHEET_DATE_FMT = "%d-%b-%Y"  # 09-Aug-2026
ZEPTO_DATE_FMT = "%d-%m-%Y"  # 09-08-2026
PORTAL_DATE_FMT = "%m/%d/%Y"  # what the request dialog wants


# Which row in each tab holds the column names, 0-based. These are not all the
# first row: the data tab keeps a blank row above its header, and the master
# sheet carries two rows of totals above its own.
HEADER_ROW = {
    DATA_TAB: 1,
    "EAN OMS Mapping": 0,
    "Zone Mapping": 0,
    "Master Sheet-OMS": 2,
}


def _read_tab(tab: str) -> pd.DataFrame:
    """Read a tab through the Sheets API, with its header row named explicitly.

    This used to go through the sheet's public gviz CSV endpoint, which guesses
    where the header is. On "Master Sheet-OMS" it guessed differently from what
    the caller assumed and returned a data row as the column names, so the
    Catalog+Color lookup came back empty and column I was written blank. The API
    hands back raw cells, so the header row is ours to state rather than infer.
    """
    header = HEADER_ROW[tab]
    import gsheet

    rows = gsheet.worksheet(SHEET_ID, tab).get_all_values()
    if len(rows) <= header:
        raise SystemExit(f"{tab!r} has no header at row {header + 1}.")

    # Repeated headers get a suffix, the way pandas does it — "SALES DATA-Zepto"
    # has two columns called "Month".
    seen: dict[str, int] = {}
    cols = []
    for raw in rows[header]:
        name = str(raw).strip()
        if name in seen:
            seen[name] += 1
            name = f"{name}.{seen[name]}"
        else:
            seen[name] = 0
        cols.append(name)

    width = len(cols)
    body = [(r + [""] * width)[:width] for r in rows[header + 1 :]]
    return pd.DataFrame(body, columns=cols, dtype=str)


def week_num(d: dt.date) -> int:
    """Google's WEEKNUM type 1: weeks start Sunday, Jan 1 falls in week 1."""
    jan1 = dt.date(d.year, 1, 1)
    return (d.toordinal() - jan1.toordinal() + jan1.isoweekday() % 7) // 7 + 1


def load_lookups() -> tuple[dict, dict, dict]:
    """Return (ean -> (sku, size), city -> zone, sku -> catalog+color)."""
    ean_tab = _read_tab("EAN OMS Mapping")
    zone_tab = _read_tab("Zone Mapping")
    master = _read_tab("Master Sheet-OMS")

    ean_map = {
        str(r["EAN No."]).strip(): (str(r["sku"]).strip(), str(r["Size"]).strip())
        for _, r in ean_tab.iterrows()
        if str(r.get("EAN No.") or "").strip()
    }
    zone_map = {
        str(r["Location"]).strip(): str(r["Zone"]).strip()
        for _, r in zone_tab.iterrows()
        if str(r.get("Location") or "").strip()
    }
    catalog_map = {
        str(r["SKU"]).strip(): str(r["Catalog +Color"]).strip()
        for _, r in master.iterrows()
        if str(r.get("SKU") or "").strip()
    }
    return ean_map, zone_map, catalog_map


def existing_dates() -> set[dt.date]:
    """Dates already recorded in the data tab."""
    df = _read_tab(DATA_TAB)
    parsed = pd.to_datetime(df["Date"], format=SHEET_DATE_FMT, errors="coerce")
    return {d.date() for d in parsed.dropna()}


def transform(zepto_csv: str | bytes, lookups=None) -> pd.DataFrame:
    """Map a Zepto Sales_F export into the sheet's schema.

    Takes either a path or the CSV's bytes, so the daily job can feed the
    download straight through without it ever touching the disk.
    """
    ean_map, zone_map, catalog_map = lookups or load_lookups()
    src = pd.read_csv(
        io.BytesIO(zepto_csv) if isinstance(zepto_csv, bytes) else zepto_csv, dtype=str
    )

    # A value Zepto sends that the lookup tabs don't know yet — a new city, a
    # newly listed EAN — is reported loudly but never stops the sync: the row
    # still lands with that one cell blank, so no sales go missing while the
    # mapping is caught up. Dropping the row, or aborting, would silently hold
    # a whole day out of the sheet.
    unknown_ean = sorted(set(src["EAN"].str.strip()) - set(ean_map))
    unknown_city = sorted(set(src["City"].str.strip()) - set(zone_map))
    if unknown_ean:
        print(
            f"  WARNING: {len(unknown_ean)} EAN(s) missing from 'EAN OMS Mapping': "
            f"{unknown_ean[:10]} — their Seller SKU Code and Size will be blank.",
            flush=True,
        )
    if unknown_city:
        print(
            f"  WARNING: city not in 'Zone Mapping': {unknown_city} — "
            "their Zone will be blank. Add the mapping to fill it in.",
            flush=True,
        )

    if GSV_COLUMN not in src.columns:
        raise SystemExit(
            f"Sales_F export has no {GSV_COLUMN!r} column, which feeds "
            f"'Sale Value'. Columns found: {list(src.columns)}"
        )

    rows = []
    for _, r in src.iterrows():
        day = dt.datetime.strptime(r["Date"].strip(), ZEPTO_DATE_FMT).date()
        sku, size = ean_map.get(r["EAN"].strip(), ("", ""))
        rows.append(
            {
                # Month (A) and Category (F) are filled in as formulas at write
                # time, once the destination row number is known.
                "Month": "",
                "Date": day.strftime(SHEET_DATE_FMT),
                "Listing Sku Code": sku,
                "EAN": int(r["EAN"].strip()),
                "Channel Name": CHANNEL_NAME,
                "Category": "",
                "Qty": int(r["Sales (Qty) - Units"]),
                "Sale Value": _money(r[GSV_COLUMN]),
                "Catalog Name+Color": catalog_map.get(sku, "") if sku else "",
                "Size": size,
                "City": r["City"].strip(),
                "Zone": zone_map.get(r["City"].strip(), ""),
                "Week NUm": week_num(day),
                "Month Num": day.month,
                "Year": day.year,
            }
        )

    out = pd.DataFrame(rows, columns=COLUMNS)
    missing_catalog = out[(out["Catalog Name+Color"] == "") & (out["Listing Sku Code"] != "")]
    if not missing_catalog.empty:
        skus = sorted(missing_catalog["Listing Sku Code"].unique())
        print(
            f"  warning: no Catalog +Color in 'Master Sheet-OMS' for {skus}",
            flush=True,
        )
    return out


def _money(raw) -> float:
    """A Gross Selling Value cell as a number. Blank or unparseable -> 0.0."""
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return 0.0
    text = str(raw).strip().replace(",", "").replace("₹", "")
    if not text:
        return 0.0
    try:
        return round(float(text), 2)
    except ValueError:
        return 0.0


def to_sheet_values(df: pd.DataFrame, first_row: int) -> list[list]:
    """Rows as JSON-safe values, numbers kept numeric so cell formats hold.

    first_row is the sheet row the first value lands on, which the A and F
    formulas need in order to point at their own row.
    """
    values = []
    for offset, (_, r) in enumerate(df.iterrows()):
        row_no = first_row + offset
        out = []
        for c in COLUMNS:
            if c in FORMULAS:
                out.append(FORMULAS[c].format(row=row_no))
            elif c in NUMERIC:
                out.append(int(r[c]))
            elif c in DECIMAL:
                out.append(float(r[c]))
            else:
                out.append(str(r[c]))
        values.append(out)
    return values


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("csv", nargs="?", help="Zepto export; default = newest download")
    ap.add_argument(
        "--from-portal",
        action="store_true",
        help="fetch the report from Zepto in this process, without saving a file",
    )
    ap.add_argument("--from", dest="start", help="mm/dd/yyyy, with --from-portal")
    ap.add_argument("--to", dest="end", help="mm/dd/yyyy, with --from-portal")
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="write the pending rows to a CSV instead of the sheet",
    )
    ap.add_argument("--days", type=int, default=10, help="how far back to check")
    args = ap.parse_args()

    print("Checking what the sheet already has...", flush=True)
    have = existing_dates()
    today = dt.date.today()
    window = {today - dt.timedelta(days=n) for n in range(1, args.days + 1)}
    missing = sorted(window - have)
    print(f"  latest in sheet : {max(have) if have else 'none'}")
    print(f"  missing in last {args.days} days: "
          f"{[d.strftime(SHEET_DATE_FMT) for d in missing] or 'none'}")

    if args.from_portal:
        import download_report

        start, end = args.start, args.end
        if not (start and end):
            if not missing:
                print(
                    f"\nEvery day in the last {args.days} is already in the sheet "
                    "— nothing to fetch."
                )
                return 0
            # Ask for one range covering everything absent, so days the job
            # never ran for are collected on the next run instead of being lost.
            # Never narrower than the usual two-day window.
            span_start = min(min(missing), today - dt.timedelta(days=2))
            span_end = today - dt.timedelta(days=1)
            start = span_start.strftime(PORTAL_DATE_FMT)
            end = span_end.strftime(PORTAL_DATE_FMT)
            if span_start < today - dt.timedelta(days=2):
                print(
                    f"  backfilling {(span_end - span_start).days + 1} days "
                    f"({span_start:{SHEET_DATE_FMT}} -> {span_end:{SHEET_DATE_FMT}})",
                    flush=True,
                )

        label, data = download_report.fetch_report(start=start, end=end)
        source: str | bytes = data
        print(f"Source: Zepto portal, {label} ({len(data):,} bytes, not saved)")
    elif args.csv:
        source = args.csv
        print(f"Source: {source}", flush=True)
    else:
        found = sorted(config.DOWNLOADS.glob("Sales_F_*.csv"))
        if not found:
            raise SystemExit(
                "No Sales_F download found. Use --from-portal, or pass a CSV."
            )
        source = str(found[-1])
        print(f"Source: {source}", flush=True)

    print("Loading lookup tabs...", flush=True)
    rows = transform(source)
    print(f"Transformed {len(rows)} rows.", flush=True)

    have_str = {d.strftime(SHEET_DATE_FMT) for d in have}
    pending = rows[~rows["Date"].isin(have_str)]
    print(f"\nRows to append: {len(pending)}")
    if not pending.empty:
        print(f"  dates: {sorted(pending['Date'].unique())}")

    if args.dry_run:
        target = config.DOWNLOADS / "pending_rows.csv"
        pending.to_csv(target, index=False)
        print(f"\nDry run — wrote {target}")
        print(f"\nFirst 3 rows as they would be written to "
              f"{FIRST_COL}..{LAST_COL} (row numbers are illustrative):")
        for row in to_sheet_values(pending.head(3), 15464):
            print(f"  {row}")
        return 0

    if pending.empty:
        print("\nNothing to append — the sheet is already up to date.")
        return 0

    import gsheet

    ws = gsheet.worksheet(SHEET_ID, DATA_TAB)

    # Append-only, by decision: a date already in the sheet is never rewritten,
    # even when Zepto later revises its figures for that date. The sheet is the
    # record of what was reported on the day, and the Weekly Sales tabs key off
    # it. Re-checked against the live tab rather than the cached read, so a
    # second run in the same day cannot duplicate rows.
    live = ws.get_all_values()
    date_col = COLUMNS.index("Date")
    live_dates = {
        r[date_col].strip()
        for r in live[2:]
        if len(r) > date_col and r[date_col].strip()
    }
    pending = pending[~pending["Date"].isin(live_dates)]
    if pending.empty:
        print("\nThose dates are already in the sheet — nothing to do.")
        return 0

    print(f"\nAppending {len(pending)} rows for {sorted(pending['Date'].unique())}")
    start = gsheet.next_row(ws, live)
    result = gsheet.append_rows(ws, to_sheet_values(pending, start), start, LAST_COL)
    print(f"Done: {result}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
