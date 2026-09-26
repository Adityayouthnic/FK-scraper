"""Request a Zepto report and download it — all within a single login.

Flow, matching the portal UI:
  Reports -> Request Report -> pick type, from/to dates -> Submit
  -> refresh until the new row reads "Completed" -> Download

A request is only submitted when the Reports table has no row for the same type
and date range yet: a report Zepto already generated is downloaded again instead
of being re-generated, so re-running the day's job does not pile up duplicate
rows in the portal. Pass --force to request a fresh one regardless.

Everything happens in one browser session; the login (and its OTP) runs at most
once per invocation.

    python download_report.py                     Sales_F, day-2 .. day-1
    python download_report.py --type "Fill Rate"
    python download_report.py --from 08/01/2026 --to 08/09/2026
    python download_report.py --force             ignore any existing report
"""

import argparse
import datetime as dt
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit
from urllib.request import urlopen

from playwright.sync_api import sync_playwright

import config
from zepto_login import auto_login, is_logged_in, open_portal

REPORTS_URL = f"{config.BASE_URL}/vendor/reports"

DEFAULT_TYPE = "Sales_F"
# Stock-snapshot reports: the dialog offers no date boxes and the table shows
# "-" for their range. There is only ever "now", so a same-day request is the
# thing to reuse. The request path also detects this from the dialog itself, so
# a type missing from here still works — it just cannot be matched for reuse.
DATELESS_TYPES = {"vendorinventoryf", "deqinventory"}
# The portal's date inputs are mm/dd/yyyy regardless of how the table displays.
DATE_FMT = "%m/%d/%Y"
# ...and the table renders ranges as "12 Aug 2026 - 13 Aug 2026".
TABLE_DATE_RE = re.compile(r"\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}")

# How long to keep refreshing while the report generates.
COMPLETE_TIMEOUT_S = 300
REFRESH_EVERY_S = 10


def default_dates() -> tuple[str, str]:
    """From = today-2, To = today-1, as the portal expects them."""
    today = dt.date.today()
    return (
        (today - dt.timedelta(days=2)).strftime(DATE_FMT),
        (today - dt.timedelta(days=1)).strftime(DATE_FMT),
    )


def _table_rows(page) -> list[dict]:
    """The Reports table as dicts: Requested At, Request ID, Type, Range, Status."""
    return page.evaluate("""
    () => [...document.querySelectorAll('table tbody tr')]
        .map(r => ({
            requested_at: (r.cells[0]?.innerText || '').trim(),
            request_id:   (r.cells[1]?.innerText || '').trim(),
            type:         (r.cells[2]?.innerText || '').trim(),
            range:        (r.cells[3]?.innerText || '').trim(),
            status:       (r.cells[4]?.innerText || '').trim(),
        }))
        .filter(r => r.request_id)
    """)


def _request_ids(page) -> set[str]:
    """Request IDs currently listed, so we can spot the row we just created."""
    return {r["request_id"] for r in _table_rows(page)}


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def _type_matches(cell: str, report_type: str) -> bool:
    """Match the table's badge against a report type from the dropdown.

    The badge is a coarse category, not the type: Sales_F shows as "SALES" and
    Vendor Inventory_F as "INVENTORY". So one has to contain the other. That
    makes the badge ambiguous between types in the same category (Vendor
    Inventory_F vs DEQ Inventory) — acceptable, because the only consequence is
    reusing a same-day snapshot of the neighbouring type, and this job requests
    exactly one of them.
    """
    a, b = _norm(cell), _norm(report_type)
    if len(a) < 4 or len(b) < 4:
        return False
    return a in b or b in a


def _range_matches(cell: str, start: str, end: str) -> bool:
    """True when the table's "12 Aug 2026 - 13 Aug 2026" is our from/to pair."""
    found = TABLE_DATE_RE.findall(cell)
    if len(found) != 2:
        return False  # e.g. INVENTORY rows, which show "-"
    parsed = []
    for text in found:
        for fmt in ("%d %b %Y", "%d %B %Y"):
            try:
                parsed.append(dt.datetime.strptime(text.strip(), fmt).date())
                break
            except ValueError:
                continue
    if len(parsed) != 2:
        return False
    want = [dt.datetime.strptime(d, DATE_FMT).date() for d in (start, end)]
    return parsed == want


def is_dateless(report_type: str) -> bool:
    return _norm(report_type) in DATELESS_TYPES


def _requested_today(cell: str) -> bool:
    """True when the "Requested At" cell is today — how a snapshot is matched."""
    found = TABLE_DATE_RE.search(cell)
    if not found:
        return False
    for fmt in ("%d %b %Y", "%d %B %Y"):
        try:
            return dt.datetime.strptime(found.group().strip(), fmt).date() == dt.date.today()
        except ValueError:
            continue
    return False


def find_existing(
    page, report_type: str, start: str | None, end: str | None
) -> dict | None:
    """The most recent report already generated for this type and range.

    Rows are newest-first, so the first match is the freshest copy. A row that
    is still generating counts as a match too — waiting on it beats queueing a
    second identical request beside it. Snapshot reports carry no range, so for
    those "same report" means one requested today: yesterday's stock is not the
    stock we were asked for.
    """
    for row in _table_rows(page):
        if not _type_matches(row["type"], report_type):
            continue
        if "Failed" in row["status"]:
            continue
        if start and end:
            if not _range_matches(row["range"], start, end):
                continue
        else:
            if TABLE_DATE_RE.search(row["range"]):
                continue  # a ranged report, not the snapshot we want
            if not _requested_today(row["requested_at"]):
                continue
        return row
    return None


def _row_locator(page, request_id: str):
    return page.locator("table tbody tr").filter(has_text=request_id).first


def open_reports(page) -> None:
    page.goto(REPORTS_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(7000)


def _pick_report_type(page, report_type: str) -> None:
    """Open the Report Type control and choose an option by exact name.

    This is a MUI Select: input[name=reportType] is an aria-hidden shadow input,
    and the clickable control is the combobox div that sits over it.
    """
    page.locator("#reportType[role='combobox'], div[role='combobox']#reportType").first.click()
    page.wait_for_timeout(1500)

    for build in (
        lambda: page.get_by_role("option", name=report_type, exact=True),
        lambda: page.locator("li[role='option']").filter(has_text=report_type),
        lambda: page.locator("ul[role='listbox'] li").filter(has_text=report_type),
        lambda: page.get_by_text(report_type, exact=True),
    ):
        try:
            loc = build()
            if loc.count() and loc.first.is_visible():
                loc.first.click()
                page.wait_for_timeout(1000)
                return
        except Exception:
            continue

    raise SystemExit(
        f"Could not find report type {report_type!r} in the dropdown. "
        "Check the exact spelling against the portal."
    )


def _dump_dialog_inputs(page) -> list[dict]:
    """List the dialog's visible inputs — the modal re-renders after type
    selection, so field names are not stable enough to hard-code."""
    fields = page.evaluate("""
    () => [...document.querySelectorAll('input')]
        .filter(i => i.offsetWidth || i.offsetHeight)
        .map(i => ({ name: i.name, id: i.id, type: i.type,
                     ph: i.placeholder, label: i.getAttribute('aria-label') }))
    """)
    print(f"  dialog inputs: {fields}", flush=True)
    return fields


def _date_box(page, which: str):
    """Locate the From/To date box by placeholder, falling back to position."""
    dated = page.locator("input[placeholder='mm/dd/yyyy']")
    if dated.count() >= 2:
        return dated.nth(0 if which == "from" else 1)

    named = page.locator(
        f"input[name='{'startDate' if which == 'from' else 'endDate'}']"
    )
    if named.count():
        return named.first

    # Last resort: any visible tel/text input that isn't the report-type field.
    generic = page.locator("input[type='tel'], input[inputmode='numeric']")
    if generic.count() >= 2:
        return generic.nth(0 if which == "from" else 1)

    raise SystemExit(
        f"Could not locate the {which!r} date box. See the dialog inputs above."
    )


def _fill_date(page, which: str, value: str) -> None:
    """Type a date into the masked mm/dd/yyyy box.

    MUI's masked field inserts the slashes itself, so we send digits only and
    let the mask lay them out. Beats driving the calendar popup.
    """
    box = _date_box(page, which)
    digits = value.replace("/", "")

    def landed() -> str:
        got = box.input_value().strip()
        return got if digits in got.replace("/", "") else ""

    # React-controlled masked inputs accept some of these and ignore others,
    # so try in order and stop at the first that actually sticks.
    strategies = (
        ("type digits", lambda: (box.click(), page.keyboard.press("Control+A"),
                                 page.keyboard.type(digits, delay=120))),
        ("type formatted", lambda: (box.click(), page.keyboard.press("Control+A"),
                                    page.keyboard.type(value, delay=120))),
        ("fill", lambda: box.fill(value)),
        ("native setter", lambda: _set_via_js(page, box, value)),
    )

    for name, apply in strategies:
        try:
            apply()
        except Exception as exc:
            print(f"  {which}: {name} errored ({type(exc).__name__})", flush=True)
            continue
        page.wait_for_timeout(700)
        got = landed()
        if got:
            print(f"  {which} = {got}  (via {name})", flush=True)
            return

    raise SystemExit(
        f"{which} date did not accept {value!r} (field stays "
        f"{box.input_value()!r}) after trying: "
        + ", ".join(n for n, _ in strategies)
    )


def _set_via_js(page, box, value: str) -> None:
    """Write through React's own setter so its state updates with the DOM."""
    box.evaluate(
        """
        (el, v) => {
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        """,
        value,
    )


def request_report(
    page, report_type: str, start: str | None = None, end: str | None = None
) -> set[str]:
    """Submit a new report request. Returns the request IDs seen beforehand."""
    span = f": {start} -> {end}" if start and end else " (snapshot — no date range)"
    print(f"Requesting {report_type}{span}", flush=True)

    open_reports(page)
    before = _request_ids(page)

    page.get_by_role("button", name="Request Report").first.click()
    page.wait_for_timeout(3000)

    _dump_dialog_inputs(page)
    _pick_report_type(page, report_type)
    fields = _dump_dialog_inputs(page)  # the modal re-renders once a type is chosen

    # Stock reports render no date boxes at all; anything typed would land in
    # the wrong field, so go by what the dialog actually offers.
    has_dates = any((f.get("ph") or "").lower() == "mm/dd/yyyy" for f in fields)
    if has_dates and start and end:
        _fill_date(page, "from", start)
        _fill_date(page, "to", end)
    elif has_dates:
        raise SystemExit(
            f"{report_type!r} asks for a date range but none was given."
        )

    page.get_by_role("button", name="Submit", exact=True).click()
    print("  submitted", flush=True)
    page.wait_for_timeout(5000)
    return before


def wait_for_new_row(page, before: set[str], request_id: str | None = None):
    """Refresh until the request appears and reads Completed.

    With request_id given we are waiting on a row that already exists; without
    it, on whichever row shows up that was not in `before`.
    """
    deadline = dt.datetime.now() + dt.timedelta(seconds=COMPLETE_TIMEOUT_S)

    while dt.datetime.now() < deadline:
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(6000)

        if request_id is None:
            new = _request_ids(page) - before
            if new:
                request_id = sorted(new)[0]
                print(f"  new request: {request_id}", flush=True)

        if request_id:
            row = _row_locator(page, request_id)
            if row.count():
                status = row.inner_text()
                if "Completed" in status:
                    print("  status: Completed", flush=True)
                    return row
                if "Failed" in status:
                    raise SystemExit(f"Zepto reported the request {request_id} failed.")
                print("  still generating...", flush=True)
            else:
                print("  waiting for the row to appear...", flush=True)
def open_reports(page) -> None:
    page.goto(REPORTS_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(7000)


def _pick_report_type(page, report_type: str) -> None:
    """Open the Report Type control and choose an option by exact name.

    This is a MUI Select: input[name=reportType] is an aria-hidden shadow input,
    and the clickable control is the combobox div that sits over it.
    """
    page.locator("#reportType[role='combobox'], div[role='combobox']#reportType").first.click()
    page.wait_for_timeout(1500)

    for build in (
        lambda: page.get_by_role("option", name=report_type, exact=True),
        lambda: page.locator("li[role='option']").filter(has_text=report_type),
        lambda: page.locator("ul[role='listbox'] li").filter(has_text=report_type),
        lambda: page.get_by_text(report_type, exact=True),
    ):
        try:
            loc = build()
            if loc.count() and loc.first.is_visible():
                loc.first.click()
                page.wait_for_timeout(1000)
                return
        except Exception:
            continue

    raise SystemExit(
        f"Could not find report type {report_type!r} in the dropdown. "
        "Check the exact spelling against the portal."
    )


def _dump_dialog_inputs(page) -> list[dict]:
    """List the dialog's visible inputs — the modal re-renders after type
    selection, so field names are not stable enough to hard-code."""
    fields = page.evaluate("""
    () => [...document.querySelectorAll('input')]
        .filter(i => i.offsetWidth || i.offsetHeight)
        .map(i => ({ name: i.name, id: i.id, type: i.type,
                     ph: i.placeholder, label: i.getAttribute('aria-label') }))
    """)
    print(f"  dialog inputs: {fields}", flush=True)
    return fields


def _date_box(page, which: str):
    """Locate the From/To date box by placeholder, falling back to position."""
    dated = page.locator("input[placeholder='mm/dd/yyyy']")
    if dated.count() >= 2:
        return dated.nth(0 if which == "from" else 1)

    named = page.locator(
        f"input[name='{'startDate' if which == 'from' else 'endDate'}']"
    )
    if named.count():
        return named.first

    # Last resort: any visible tel/text input that isn't the report-type field.
    generic = page.locator("input[type='tel'], input[inputmode='numeric']")
    if generic.count() >= 2:
        return generic.nth(0 if which == "from" else 1)

    raise SystemExit(
        f"Could not locate the {which!r} date box. See the dialog inputs above."
    )


def _fill_date(page, which: str, value: str) -> None:
    """Type a date into the masked mm/dd/yyyy box.

    MUI's masked field inserts the slashes itself, so we send digits only and
    let the mask lay them out. Beats driving the calendar popup.
    """
    box = _date_box(page, which)
    digits = value.replace("/", "")

    def landed() -> str:
        got = box.input_value().strip()
        return got if digits in got.replace("/", "") else ""

    # React-controlled masked inputs accept some of these and ignore others,
    # so try in order and stop at the first that actually sticks.
    strategies = (
        ("type digits", lambda: (box.click(), page.keyboard.press("Control+A"),
                                 page.keyboard.type(digits, delay=120))),
        ("type formatted", lambda: (box.click(), page.keyboard.press("Control+A"),
                                    page.keyboard.type(value, delay=120))),
        ("fill", lambda: box.fill(value)),
        ("native setter", lambda: _set_via_js(page, box, value)),
    )

    for name, apply in strategies:
        try:
            apply()
        except Exception as exc:
            print(f"  {which}: {name} errored ({type(exc).__name__})", flush=True)
            continue
        page.wait_for_timeout(700)
        got = landed()
        if got:
            print(f"  {which} = {got}  (via {name})", flush=True)
            return

    raise SystemExit(
        f"{which} date did not accept {value!r} (field stays "
        f"{box.input_value()!r}) after trying: "
        + ", ".join(n for n, _ in strategies)
    )


def _set_via_js(page, box, value: str) -> None:
    """Write through React's own setter so its state updates with the DOM."""
    box.evaluate(
        """
        (el, v) => {
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        """,
        value,
    )


def request_report(
    page, report_type: str, start: str | None = None, end: str | None = None
) -> set[str]:
    """Submit a new report request. Returns the request IDs seen beforehand."""
    span = f": {start} -> {end}" if start and end else " (snapshot — no date range)"
    print(f"Requesting {report_type}{span}", flush=True)

    open_reports(page)
    before = _request_ids(page)

    page.get_by_role("button", name="Request Report").first.click()
    page.wait_for_timeout(3000)

    _dump_dialog_inputs(page)
    _pick_report_type(page, report_type)
    fields = _dump_dialog_inputs(page)  # the modal re-renders once a type is chosen

    # Stock reports render no date boxes at all; anything typed would land in
    # the wrong field, so go by what the dialog actually offers.
    has_dates = any((f.get("ph") or "").lower() == "mm/dd/yyyy" for f in fields)
    if has_dates and start and end:
        _fill_date(page, "from", start)
        _fill_date(page, "to", end)
    elif has_dates:
        raise SystemExit(
            f"{report_type!r} asks for a date range but none was given."
        )

    page.get_by_role("button", name="Submit", exact=True).click()
    print("  submitted", flush=True)
    page.wait_for_timeout(5000)
    return before


def wait_for_new_row(page, before: set[str], request_id: str | None = None):
    """Refresh until the request appears and reads Completed.

    With request_id given we are waiting on a row that already exists; without
    it, on whichever row shows up that was not in `before`.
    """
    deadline = dt.datetime.now() + dt.timedelta(seconds=COMPLETE_TIMEOUT_S)

    while dt.datetime.now() < deadline:
        page.reload(wait_until="domcontentloaded")
        page.wait_for_timeout(6000)

        if request_id is None:
            new = _request_ids(page) - before
            if new:
                request_id = sorted(new)[0]
                print(f"  new request: {request_id}", flush=True)

        if request_id:
            row = _row_locator(page, request_id)
            if row.count():
                status = row.inner_text()
                if "Completed" in status:
                    print("  status: Completed", flush=True)
                    return row
                if "Failed" in status:
                    raise SystemExit(f"Zepto reported the request {request_id} failed.")
                print("  still generating...", flush=True)
            else:
                print("  waiting for the row to appear...", flush=True)
        else:
            print("  waiting for the request to register...", flush=True)

        page.wait_for_timeout(REFRESH_EVERY_S * 1000)

    raise SystemExit(
        f"Report did not complete within {COMPLETE_TIMEOUT_S}s. "
        "It may still finish — check the portal."
    )


def read_row(page, row) -> tuple[str, bytes]:
    """Download a report without relying on Chrome's temp file.

    Zepto's Download button calls its reports API for a signed S3 URL, then
    starts a browser download.  The portal now sometimes closes the persistent
    browser context immediately afterwards.  In that case Playwright has already
    emitted the download event, but ``download.path()`` can no longer reach its
    temporary artifact.  Capture the API response and read the signed URL
    independently so a closing page cannot discard the CSV.
    """
    request_id = ""
    tds = row.locator("td")
    if tds.count() > 1:
        request_id = tds.nth(1).inner_text().strip()
    if not request_id:
        match = re.search(r"[0-9a-fA-F-]{36}", row.inner_text())
        if match:
            request_id = match.group(0).strip()
    if not request_id:
        raise RuntimeError("Could not read the report request ID.")

    api_path = f"/api/v1/reports/{request_id}/download"
    signed_url = None

    # Try fetching the download URL directly from the authenticated page context.
    # This avoids clicking the UI button which triggers system Chrome's download
    # manager and can cause crashes or context closure.
    try:
        payload = page.evaluate(
            """
            async (path) => {
                let token = null;
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    if (/token|auth|jwt/i.test(key)) {
                        const val = localStorage.getItem(key);
                        if (val && typeof val === 'string' && val.length > 20) {
                            try {
                                const parsed = JSON.parse(val);
                                token = parsed.token || parsed.accessToken || parsed.access_token || parsed.jwt || parsed;
                            } catch {
                                token = val;
                            }
                            if (token && typeof token === 'string') break;
                        }
                    }
                }
                const headers = { 'Accept': 'application/json' };
                if (token && typeof token === 'string') {
                    headers['Authorization'] = token.startsWith('Bearer ') ? token : `Bearer ${token.replace(/^"|"$/g, '')}`;
                }
                const res = await fetch(path, {
                    method: 'GET',
                    headers: headers,
                    credentials: 'include'
                });
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
                }
                return await res.json();
            }
            """,
            api_path,
        )
        signed_url = (payload.get("data") or {}).get("presignedS3Url")
    except Exception as fetch_exc:
        print(f"  direct API fetch note: {fetch_exc} — falling back to button click", flush=True)

    if not signed_url:
        link = row.get_by_text("Download", exact=False).first
        with page.expect_response(
            lambda response: (
                response.request.method == "GET"
                and (
                    urlsplit(response.url).path == api_path
                    or f"/reports/{request_id}/download" in response.url
                )
            ),
            timeout=120_000,
        ) as info:
            link.click()

        response = info.value
        if not response.ok:
            raise RuntimeError(
                f"Zepto's download API returned HTTP {response.status} for "
                f"request {request_id}."
            )

        payload = response.json()
        signed_url = (payload.get("data") or {}).get("presignedS3Url")

    if not signed_url:
        raise RuntimeError(
            "Zepto's download API did not return data.presignedS3Url for "
            f"request {request_id}."
        )

    name = unquote(Path(urlsplit(signed_url).path).name)
    with urlopen(signed_url, timeout=120) as source:
        data = source.read()
    if not data:
        raise RuntimeError(f"Zepto returned an empty download for request {request_id}.")
    return name, data


# Backward compatibility for snapshot callers
read_snapshot_row = read_row


def save_row(page, row, report_type: str, reader=read_row) -> str:
    """As read_row, but also writes the CSV under downloads/ and returns its path."""
    name, data = reader(page, row)
    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    suffix = "".join(c for c in name if c not in '\\/:*?"<>|')
    target = config.DOWNLOADS / f"{report_type}_{stamp}_{suffix}"
    target.write_bytes(data)
    return str(target)


def locate_report(
    page,
    report_type: str,
    start: str | None,
    end: str | None,
    force: bool = False,
):
    """The table row to download from — reusing, waiting, or requesting anew."""
    span = f"{start} -> {end}" if start and end else "today"
    if not force:
        open_reports(page)
        found = find_existing(page, report_type, start, end)
        if found and "Completed" in found["status"]:
            print(
                f"Report already generated for {span} "
                f"({found['request_id']}) — downloading it instead of "
                "requesting a new one.",
                flush=True,
            )
            return _row_locator(page, found["request_id"])
        if found:
            print(
                f"A request for {span} is already running "
                f"({found['request_id']}) — waiting on it.",
                flush=True,
            )
            return wait_for_new_row(page, set(), found["request_id"])

    before = request_report(page, report_type, start, end)
    return wait_for_new_row(page, before)


def fetch_report(
    report_type: str = DEFAULT_TYPE,
    start: str | None = None,
    end: str | None = None,
    force: bool = False,
    save: bool = False,
) -> tuple[str, bytes]:
    """Sign in, get the report for this range, return (source label, CSV bytes).

    One browser session, one login. With save=True a copy also lands in
    downloads/ and the label is that path; otherwise the label is just the
    portal's filename, since nothing was written anywhere.
    """
    if is_dateless(report_type):
        start = end = None  # a snapshot; the portal offers no range for these
    elif start is None or end is None:
        default_start, default_end = default_dates()
        start, end = start or default_start, end or default_end

    with sync_playwright() as pw:
        context, page = open_portal(pw, headed=config.HEADED)
        try:
            if not is_logged_in(page):
                auto_login(page)  # at most once per run
            else:
                print("Reusing the existing session.", flush=True)

            row = locate_report(page, report_type, start, end, force)
            reader = read_row
            if save:
                path = save_row(page, row, report_type, reader)
                return path, Path(path).read_bytes()
            return reader(page, row)
        except Exception as exc:
            print(f"fetch_report failed: {type(exc).__name__}: {exc}", flush=True)
            # Do not let the diagnostic hide the exception that actually broke
            # the download.  The portal sometimes closes the page/context while
            # a download is being started; screenshot() then raises its own
            # TargetClosedError and used to replace the useful traceback.
            screenshot = config.LOGS / "download_failed.png"
            try:
                if not page.is_closed():
                    page.screenshot(path=str(screenshot))
                    print(f"See {screenshot}", flush=True)
                else:
                    print("Could not take a failure screenshot: page is closed.", flush=True)
            except Exception as screenshot_error:
                print(
                    "Could not take a failure screenshot: "
                    f"{type(screenshot_error).__name__}: {screenshot_error}",
                    flush=True,
                )
            raise
        finally:
            try:
                context.close()
            except Exception as close_exc:
                print(f"  (context.close note: {close_exc})", flush=True)


def main() -> int:
    start_default, end_default = default_dates()
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--type", default=DEFAULT_TYPE, help="report type as listed")
    ap.add_argument("--from", dest="start", default=start_default, help="mm/dd/yyyy")
    ap.add_argument("--to", dest="end", default=end_default, help="mm/dd/yyyy")
    ap.add_argument(
        "--force",
        action="store_true",
        help="request a new report even if one already exists for this range",
    )
    ap.add_argument(
        "--no-save",
        action="store_true",
        help="fetch without writing the CSV to downloads/ (what the daily job does)",
    )
    args = ap.parse_args()

    label, data = fetch_report(
        args.type, args.start, args.end, force=args.force, save=not args.no_save
    )
    where = "in memory only" if args.no_save else label
    print(f"\nDownloaded {len(data):,} bytes: {where}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
