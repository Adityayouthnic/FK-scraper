"""Refresh the "FC Inventory In Zepto" tab from a Vendor Inventory_F export.

Inventory is a snapshot, not a ledger: the tab holds the current stock and
nothing else, so each run clears the old rows and writes today's in their place.
That is the opposite of "SALES DATA-Zepto", which only ever appends.

Only B, D, E, F are written. A (Seller SKU Code) and C (Zone) are lookups the
sheet does itself, so they are re-laid as the same formulas, row by row, exactly
as they already are in the tab:

    A  =XLOOKUP(F3,'EAN OMS Mapping'!A:A,'EAN OMS Mapping'!B:B,1,0)
    B  City   <- report
    C  =VLOOKUP(B3,'Zone Mapping'!A:B,2,0)
    D  qty    <- report "Units"
    E  date   <- the day the report was downloaded
    F  EAN    <- report

Row 1 (the =sum(D3:D) total) and row 2 (the headers) are never touched.

    python inventory_pipeline.py --from-portal    fetch and refresh the tab
    python inventory_pipeline.py --dry-run        show what would be written
"""

import argparse
import datetime as dt
import io
import sys

import pandas as pd

import config

TAB = "FC Inventory In Zepto"

SHEET_ID = config.GSHEET_ID
if not SHEET_ID:
    raise SystemExit("GSHEET_ID is not set in .env — see .env.example.")

REPORT_TYPE = "Vendor Inventory_F"

# Row 1 is the column total, row 2 the header; data lives from row 3 down.
FIRST_DATA_ROW = 3
LAST_COL = "F"

SKU_FORMULA = "=XLOOKUP(F{row},'EAN OMS Mapping'!A:A,'EAN OMS Mapping'!B:B,1,0)"
ZONE_FORMULA = "=VLOOKUP(B{row},'Zone Mapping'!A:B,2,0)"

SHEET_DATE_FMT = "%d-%b-%Y"  # 14-Aug-2026


def build_rows(report: str | bytes, on_date: dt.date) -> list[list]:
    """One sheet row per report row, in A..F order."""
    src = pd.read_csv(
        io.BytesIO(report) if isinstance(report, bytes) else report, dtype=str
    )
    missing = {"City", "EAN", "Units"} - set(src.columns)
    if missing:
        raise SystemExit(
            f"{REPORT_TYPE} export is missing {sorted(missing)}. "
            f"Columns found: {list(src.columns)}"
        )

    stamp = on_date.strftime(SHEET_DATE_FMT)
    rows = []
    for offset, (_, r) in enumerate(src.iterrows()):
        row = FIRST_DATA_ROW + offset
        rows.append(
            [
                SKU_FORMULA.format(row=row),
                r["City"].strip(),
                ZONE_FORMULA.format(row=row),
                int(r["Units"]),
                stamp,
                int(r["EAN"].strip()),
            ]
        )
    return rows


def warn_unmapped(rows: list[list]) -> None:
    """Name cities the sheet's VLOOKUP will not resolve, before it shows #N/A."""
    import sheet_pipeline

    _, zone_map, _ = sheet_pipeline.load_lookups()
    unknown = sorted({r[1] for r in rows} - set(zone_map))
    if unknown:
        print(
            f"  WARNING: city not in 'Zone Mapping': {unknown} — column C will "
            "read #N/A for those rows until the mapping is added.",
            flush=True,
        )


def refresh(ws, rows: list[list]) -> dict:
    """Replace A3:F with these rows, leaving every other cell alone."""
    if not rows:
        raise SystemExit("Refusing to clear the tab: the report produced no rows.")

    old_last = max(len(ws.get_all_values()), FIRST_DATA_ROW - 1)
    new_last = FIRST_DATA_ROW + len(rows) - 1

    if new_last > ws.row_count:
        extra = new_last - ws.row_count
        print(f"  tab holds {ws.row_count} rows; adding {extra}", flush=True)
        ws.add_rows(extra)

    # Clear down to whichever is further — today's snapshot can be shorter than
    # the one it replaces, and yesterday's tail must not survive underneath it.
    stale = f"A{FIRST_DATA_ROW}:{LAST_COL}{max(old_last, new_last)}"
    print(f"  clearing {stale}", flush=True)
    ws.batch_clear([stale])

    target = f"A{FIRST_DATA_ROW}:{LAST_COL}{new_last}"
    print(f"  writing {len(rows)} rows into {target}", flush=True)
    # USER_ENTERED so the formulas are formulas and the date is a real date.
    ws.update(values=rows, range_name=target, value_input_option="USER_ENTERED")
    return {"range": target, "rows": len(rows)}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("csv", nargs="?", help="a saved Vendor Inventory_F export")
    ap.add_argument(
        "--from-portal",
        action="store_true",
        help="fetch the report from Zepto in this process, without saving a file",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="print what would be written instead of touching the sheet",
    )
    ap.add_argument(
        "--date",
        help=f"date for column E as {SHEET_DATE_FMT} (default: today)",
    )
    args = ap.parse_args()

    on_date = (
        dt.datetime.strptime(args.date, SHEET_DATE_FMT).date()
        if args.date
        else dt.date.today()
    )

    if args.from_portal:
        import download_report

        label, source = download_report.fetch_report(REPORT_TYPE)
        print(f"Source: Zepto portal, {label} ({len(source):,} bytes, not saved)")
    elif args.csv:
        source = args.csv
        print(f"Source: {source}", flush=True)
    else:
        raise SystemExit("Pass --from-portal or a saved CSV.")

    rows = build_rows(source, on_date)
    print(f"Built {len(rows)} rows, dated {on_date:{SHEET_DATE_FMT}}.", flush=True)
    print(f"  total units: {sum(r[3] for r in rows):,}", flush=True)
    warn_unmapped(rows)

    if args.dry_run:
        print("\nDry run — first 3 rows as they would be written:")
        for r in rows[:3]:
            print(f"  {r}")
        print(f"\nWould replace A{FIRST_DATA_ROW}:{LAST_COL} "
              f"({len(rows)} rows) in {TAB!r}.")
        return 0

    import gsheet

    ws = gsheet.worksheet(SHEET_ID, TAB)
    print(f"\nRefreshing {TAB!r}", flush=True)
    print(f"Done: {refresh(ws, rows)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
