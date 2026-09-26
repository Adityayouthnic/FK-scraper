"""Pull the Zepto login OTP out of the orders@ mailbox over IMAP.

vbexports.co.in is on Google Workspace, so this connects to imap.gmail.com with
an app password (a normal account password will not work once 2-Step
Verification is on). Only mail from Zepto's OTP sender is ever read.
"""

import email
import imaplib
import re
import time
from email.header import decode_header, make_header

import config

OTP_SENDER = "mailer@zeptonow.com"
OTP_SUBJECT_HINT = "otp"

# Codes are 4-8 digits; ignore anything outside that so we don't grab a year
# or an order number out of the mail body.
_CODE_RE = re.compile(r"\b(\d{4,8})\b")


def _decode(value: str) -> str:
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value or ""


def _body_text(msg) -> str:
    """Flatten a message to searchable text, preferring plain text over HTML."""
    parts = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() in ("text/plain", "text/html"):
                try:
                    payload = part.get_payload(decode=True) or b""
                    parts.append(payload.decode(errors="ignore"))
                except Exception:
                    continue
    else:
        try:
            parts.append((msg.get_payload(decode=True) or b"").decode(errors="ignore"))
        except Exception:
            pass
    text = "\n".join(parts)
    return re.sub(r"<[^>]+>", " ", text)  # strip tags so HTML mail still parses


def _extract_code(msg) -> str | None:
    subject = _decode(msg.get("Subject", ""))
    text = f"{subject}\n{_body_text(msg)}"

    # Prefer a number sitting next to the words that introduce it.
    near = re.search(
        r"(?:otp|code|password)\D{0,40}?\b(\d{4,8})\b", text, re.IGNORECASE
    )
    if near:
        return near.group(1)

    found = _CODE_RE.search(text)
    return found.group(1) if found else None


def fetch_otp(since_ts: float, timeout_s: int = 180, poll_s: int = 10) -> str:
    """Wait for an OTP mail that arrived after since_ts and return its code.

    since_ts guards against replaying yesterday's code: only mail delivered
    after we clicked "Log In" counts.
    """
    if not (config.IMAP_USER and config.IMAP_PASSWORD):
        raise SystemExit(
            "IMAP is not configured. Add IMAP_USER and IMAP_PASSWORD (a Google "
            "app password) to .env — see README."
        )

    deadline = time.time() + timeout_s
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        code = _try_once(since_ts)
        if code:
            return code
        print(f"  no OTP mail yet (check {attempt})...", flush=True)
        time.sleep(poll_s)

    raise SystemExit(
        f"No OTP mail from {OTP_SENDER} arrived within {timeout_s}s. "
        "Check the mailbox and the IMAP settings in .env."
    )


def _try_once(since_ts: float) -> str | None:
    with imaplib.IMAP4_SSL(config.IMAP_HOST) as im:
        try:
            im.login(config.IMAP_USER, config.IMAP_PASSWORD)
        except imaplib.IMAP4.error as exc:
            # The usual cause is a revoked/rotated app password, and the raw
            # "Invalid credentials (Failure)" in the log says nothing about that.
            raise SystemExit(
                f"{config.IMAP_HOST} rejected {config.IMAP_USER}: {exc}\n"
                "IMAP_PASSWORD in .env must be a current Google APP PASSWORD "
                "(16 characters) for that mailbox, not the account password. "
                "Generate a new one at https://myaccount.google.com/apppasswords "
                "and update .env."
            ) from exc
        im.select("INBOX")

        status, data = im.search(None, "FROM", f'"{OTP_SENDER}"')
        if status != "OK" or not data or not data[0]:
            return None

        # Newest first — the most recent matching mail is the live code.
        for num in reversed(data[0].split()):
            status, raw = im.fetch(num, "(RFC822)")
            if status != "OK" or not raw or not raw[0]:
                continue
            msg = email.message_from_bytes(raw[0][1])

            # A stale code is worse than no code: if we can't prove the mail
            # arrived after this login attempt, refuse it.
            received = None
            date = msg.get("Date")
            if date:
                parsed = email.utils.parsedate_tz(date)
                if parsed:
                    try:
                        received = email.utils.mktime_tz(parsed)
                    except Exception:
                        received = None
            if received is None or received < since_ts - 30:
                return None

            if OTP_SUBJECT_HINT not in _decode(msg.get("Subject", "")).lower():
                continue

            code = _extract_code(msg)
            if code:
                return code
    return None
