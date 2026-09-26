"""Google Sheets access for the sync, via an OAuth desktop client.

The first run opens a browser once so you can grant access; the resulting token
is cached in secrets/google_token.json and refreshed automatically after that.

    python gsheet.py    authorise and print what the sheet looks like
"""

import sys

import gspread
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow

import config

CLIENT_SECRETS = config.SECRETS / "oauth_credentials.json"
TOKEN_FILE = config.SECRETS / "google_token.json"

# Sheets only — this never asks for access to the rest of your Drive.
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


def credentials() -> Credentials:
    """Return usable credentials, prompting in a browser only when required."""
    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    if creds and creds.valid:
        return creds

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
    else:
        if not CLIENT_SECRETS.exists():
            raise SystemExit(
                f"Missing {CLIENT_SECRETS}. Download the OAuth desktop client "
                "JSON from Google Cloud and save it there."
            )
        print(
            "\nOpening a browser so you can grant access to the sheet.\n"
            "Sign in as the account that owns the spreadsheet and approve.\n",
            flush=True,
        )
        flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRETS), SCOPES)
        creds = flow.run_local_server(port=0)

    TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
    print(f"Token cached in {TOKEN_FILE}", flush=True)
    return creds


def worksheet(sheet_id: str, tab: str):
    """Open one tab of a spreadsheet."""
    return gspread.authorize(credentials()).open_by_key(sheet_id).worksheet(tab)


def next_row(ws, values: list[list] | None = None) -> int:
    """The first empty row below the existing data.

    Takes an already-fetched get_all_values() when the caller has one, so a
    write does not re-read the whole tab just to find its own start.
    """
    return len(values if values is not None else ws.get_all_values()) + 1


def copy_row_format(ws, src_row: int, first_row: int, last_row: int, width: int) -> None:
    """Give rows first_row..last_row the formatting of src_row.

    Appended rows land on cells that have never been part of the data block, so
    they carry the sheet's defaults — left-aligned, default font — instead of
    the centred, formatted look of the rows above. Writing values never brings
    formatting with it, so it is copied down explicitly. Source is one row and
    the destination many; Sheets tiles the format over the whole range.

    Formatting only: PASTE_FORMAT leaves the values just written untouched.
    """
    if src_row < 1 or last_row < first_row:
        return

    def block(start_row, end_row):
        return {
            "sheetId": ws.id,
            "startRowIndex": start_row - 1,
            "endRowIndex": end_row,
            "startColumnIndex": 0,
            "endColumnIndex": width,
        }

    ws.spreadsheet.batch_update(
        {
            "requests": [
                {
                    "copyPaste": {
                        "source": block(src_row, src_row),
                        "destination": block(first_row, last_row),
                        "pasteType": "PASTE_FORMAT",
                        "pasteOrientation": "NORMAL",
                    }
                }
            ]
        }
    )


def append_rows(ws, values: list[list], start: int, last_col: str = "K") -> dict:
    """Write rows immediately below the existing data, starting at `start`.

    We target an explicit range rather than using append_rows(): this tab has a
    blank row 1 above the header, which makes the API's "find the end of the
    table" logic unreliable — it can decide the table is empty and overwrite
    from the top.

    `start` is passed in rather than derived here because the rows may carry
    formulas that reference their own row number, so the caller has to know the
    destination before it can build them.

    Writing into rows that already exist (rather than inserting new ones) keeps
    the tab's cell formatting and any formulas keyed to those ranges intact.
    USER_ENTERED lets Sheets store dates as real dates under the column's
    dd-mmm-yyyy format, numbers as numbers, and formulas as formulas.
    """
    if not values:
        return {}

    end = start + len(values) - 1
    if end > ws.row_count:
        raise SystemExit(
            f"Need rows up to {end} but the tab only has {ws.row_count}. "
            "Add rows to the sheet first."
        )

    target = f"A{start}:{last_col}{end}"
    print(f"  writing {len(values)} rows into {target}", flush=True)
    ws.update(values=values, range_name=target, value_input_option="USER_ENTERED")

    # Match the row above, so appended rows look like the rest of the table.
    # Row 2 is the header and row 1 the blank spacer, so there is only a data
    # row to copy from once the append starts at row 4 or below.
    if start >= 4:
        print(f"  copying row {start - 1}'s formatting down to row {end}", flush=True)
        copy_row_format(ws, start - 1, start, end, len(values[0]))
    return {"range": target, "rows": len(values)}


def main() -> int:
    from sheet_pipeline import DATA_TAB, SHEET_ID

    ws = worksheet(SHEET_ID, DATA_TAB)
    print(f"\nConnected to: {ws.spreadsheet.title} -> {ws.title}")
    print(f"  rows x cols : {ws.row_count} x {ws.col_count}")

    values = ws.get_all_values()
    print(f"  used rows   : {len(values)}")
    print(f"  header      : {values[1][:15]}")
    print(f"  last row    : {values[-1][:15]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
