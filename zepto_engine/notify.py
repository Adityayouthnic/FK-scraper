"""Email the daily job's failures, so a broken run is not a silent one.

Sends through the same Google mailbox the OTP is read from — the app password
in .env already works for SMTP, so this needs no new credentials. Set NOTIFY_TO
in .env to choose the recipients (comma-separated); it defaults to IMAP_USER.

    python notify.py --test    send a sample failure mail and exit
"""

import argparse
import smtplib
import ssl
import sys
from email.message import EmailMessage

import config

SUBJECT_PREFIX = "[Zepto Sync]"


def configured() -> bool:
    return bool(config.IMAP_USER and config.IMAP_PASSWORD and config.NOTIFY_TO)


def send(subject: str, body: str) -> bool:
    """Send one plain-text mail. Never raises: a failed alert must not mask the
    failure it is reporting, so problems are printed and swallowed."""
    if not configured():
        print(
            "  (no failure mail sent — set IMAP_USER/IMAP_PASSWORD and "
            "NOTIFY_TO in .env)",
            flush=True,
        )
        return False

    msg = EmailMessage()
    msg["Subject"] = f"{SUBJECT_PREFIX} {subject}"
    msg["From"] = config.IMAP_USER
    msg["To"] = ", ".join(config.NOTIFY_TO)
    msg.set_content(body)

    try:
        with smtplib.SMTP_SSL(
            config.SMTP_HOST, config.SMTP_PORT, context=ssl.create_default_context(),
            timeout=60,
        ) as smtp:
            smtp.login(config.IMAP_USER, config.IMAP_PASSWORD)
            smtp.send_message(msg)
    except Exception as exc:
        print(f"  could not send the failure mail: {type(exc).__name__}: {exc}",
              flush=True)
        return False

    print(f"  failure mail sent to {msg['To']}", flush=True)
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--test", action="store_true", help="send a sample mail")
    args = ap.parse_args()

    if not args.test:
        ap.print_help()
        return 0

    print(f"Sending a test mail to {config.NOTIFY_TO or '(nobody — NOTIFY_TO unset)'}")
    ok = send(
        "TEST — this is what a failure looks like",
        "This is a test of the Zepto sync's failure alert.\n\n"
        "A real one names the stage that failed and quotes the end of the log.\n",
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
