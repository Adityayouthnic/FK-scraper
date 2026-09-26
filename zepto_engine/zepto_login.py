"""Open an authenticated Zepto vendor-portal session.

Rather than driving a throwaway browser and replaying credentials on every run,
this keeps a real Chrome profile on disk under secrets/chrome_profile. You sign
in by hand once (password + the emailed OTP); every run after that reuses the
session that login created, exactly as if you'd opened Chrome yourself.

    python zepto_login.py --setup    one-time (or whenever the session expires)
    python zepto_login.py            check the saved session is still good
"""

import argparse
import sys
import time
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

import config
import otp_reader

PROFILE_DIR = config.SECRETS / "chrome_profile"

# How long the setup run waits for you to finish signing in.
SETUP_WAIT_MS = 600_000

_AUTH_PATHS = ("/login", "/forgot-password", "/otp", "/verify", "/two-factor")
# The portal root bounces signed-out visitors to a public marketing page, so
# "not on /login" alone does not mean we're authenticated.
_PUBLIC_PATHS = ("/zepto", "/register", "/contact-us")


def is_logged_in(page) -> bool:
    """Authenticated means no login form on screen and not on a public page.

    Paths are compared exactly: a substring test would read the real dashboard
    at /vendor/zepto-reactor as the public /zepto page.
    """
    path = urlparse(page.url).path.rstrip("/") or "/"
    if path in _AUTH_PATHS or path in _PUBLIC_PATHS or path == "/":
        return False
    try:
        return not page.get_by_placeholder("Email ID").is_visible()
    except Exception:
        return True


def open_portal(pw, headed: bool = True):
    """Return (context, page) on the portal using the saved Chrome profile."""
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    context = pw.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE_DIR),
        channel="chrome",  # real Chrome, not the bundled Chromium build
        headless=not headed,
        accept_downloads=True,
        no_viewport=True,  # fit the real window; the screen here is 1280x720
        args=["--start-maximized"],
    )
    page = context.pages[0] if context.pages else context.new_page()
    page.goto(config.LOGIN_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(5000)
    return context, page


def auto_login(page) -> None:
    """Fill the form from .env, then satisfy the OTP challenge from the mailbox."""
    if not (config.EMAIL and config.PASSWORD):
        raise SystemExit("ZEPTO_EMAIL / ZEPTO_PASSWORD missing from .env")

    print("Submitting credentials...", flush=True)
    page.goto(config.LOGIN_URL, wait_until="domcontentloaded")
    page.wait_for_timeout(3000)

    page.get_by_placeholder("Email ID").fill(config.EMAIL)
    page.get_by_placeholder("Password").fill(config.PASSWORD)

    submitted_at = time.time()
    page.get_by_role("button", name="Log In").click()

    # Wait for one of: the dashboard, the OTP challenge, or a rejection.
    for _ in range(20):
        page.wait_for_timeout(2000)
        if is_logged_in(page):
            print("Signed in — no OTP was required.", flush=True)
            return
        if _otp_input(page) is not None:
            break

        body = page.inner_text("body").lower()
        if "invalid credentials" in body or "incorrect password" in body:
            page.screenshot(path=str(config.LOGS / "login_failed.png"))
            raise SystemExit(
                'Zepto rejected the sign-in: "Invalid Credentials provided."\n'
                "ZEPTO_EMAIL / ZEPTO_PASSWORD in .env are not accepted by the "
                "portal. Verify them by signing in manually in a normal browser."
            )
    else:
        page.screenshot(path=str(config.LOGS / "login_failed.png"))
        raise SystemExit(
            f"Neither dashboard nor OTP screen appeared (still {page.url}). "
            "See logs/login_failed.png."
        )

    print("OTP screen reached. Reading the code from the mailbox...", flush=True)
    code = otp_reader.fetch_otp(since_ts=submitted_at)
    print(f"Got a {len(code)}-digit code from the OTP mail.", flush=True)

    field = _otp_input(page)
    if field is None:
        raise SystemExit("OTP field vanished before it could be filled.")
    _fill_otp(page, field, code)

    for _ in range(15):
        page.wait_for_timeout(2000)
        if is_logged_in(page):
            print("OTP accepted — signed in.", flush=True)
            return

    page.screenshot(path=str(config.LOGS / "otp_failed.png"))
    raise SystemExit(
        f"OTP was submitted but we're still on {page.url}. See logs/otp_failed.png."
    )


def _otp_input(page):
    """Locate the OTP entry, whether it's one box or a row of digit boxes."""
    # Never match the login form's own fields — an OTP typed into #email just
    # produces "Please enter a valid email".
    not_login = ":not(#email):not(#password):not([type=email]):not([type=password])"
    for build in (
        lambda: page.locator("input[autocomplete='one-time-code']"),
        lambda: page.locator(f"input[name*='otp' i]{not_login}"),
        lambda: page.locator(f"input[placeholder*='otp' i]{not_login}"),
        lambda: page.locator(f"input[type='tel']{not_login}"),
        lambda: page.locator(f"input[inputmode='numeric']{not_login}"),
        lambda: page.locator(f"input[maxlength='1']{not_login}"),
    ):
        try:
            loc = build()
            if loc.count() and loc.first.is_visible():
                return loc
        except Exception:
            continue
    return None


def _fill_otp(page, field, code: str) -> None:
    """Handle both a single input and split per-digit inputs."""
    count = field.count()
    if count >= len(code):
        for i, ch in enumerate(code):
            field.nth(i).fill(ch)
    else:
        field.first.fill(code)

    page.wait_for_timeout(1000)
    # Zepto labels this "Confirm"; the others are here for when that changes.
    # "Resend" is deliberately absent — clicking it would invalidate our code.
    for name in ("Confirm", "Verify", "Submit", "Continue", "Log In"):
        try:
            btn = page.get_by_role("button", name=name, exact=False)
            if btn.count() and btn.first.is_enabled():
                print(f"  clicking {name!r} to submit the OTP", flush=True)
                btn.first.click()
                return
        except Exception:
            continue

    print("  no submit button matched; pressing Enter", flush=True)
    field.last.press("Enter")


def setup() -> int:
    """Hold a browser open while you sign in by hand, then keep the session."""
    with sync_playwright() as pw:
        context, page = open_portal(pw, headed=True)

        if is_logged_in(page):
            print(f"Already signed in — landed on {page.url}")
        else:
            print(
                "\n" + "=" * 70,
                "Chrome is open on the Zepto login page.",
                "",
                "Sign in yourself in that window:",
                "  1. Enter your email and password.",
                "  2. Fetch the OTP mailed to orders@vbexports.co.in",
                '     (from mailer@zeptonow.com, subject "Email Otp") and enter it.',
                "",
                "Leave the window open once you reach the dashboard — this script",
                "detects it automatically and saves the session.",
                f"Waiting up to {SETUP_WAIT_MS // 60_000} minutes.",
                "=" * 70 + "\n",
                sep="\n",
                flush=True,
            )
            waited = 0
            while waited < SETUP_WAIT_MS:
                page.wait_for_timeout(3000)
                waited += 3000
                if is_logged_in(page):
                    break
            else:
                print("Timed out before sign-in completed. Re-run --setup.")
                context.close()
                return 1

        page.wait_for_timeout(3000)
        print(f"\nSigned in. Current page: {page.url}\n")
        _dump_nav(page)

        shot = config.LOGS / "after_login.png"
        page.screenshot(path=str(shot), full_page=True)
        print(f"\nScreenshot: {shot}")
        print(f"Session stored in: {PROFILE_DIR}")

        context.close()
    return 0


def check() -> int:
    """Verify the saved session still works without any manual step."""
    with sync_playwright() as pw:
        context, page = open_portal(pw, headed=config.HEADED)
        ok = is_logged_in(page)
        print(f"Session valid: {ok} (at {page.url})")
        if ok:
            _dump_nav(page)
            page.screenshot(path=str(config.LOGS / "session_check.png"), full_page=True)
        else:
            print("Session expired — run: python zepto_login.py --setup")
        context.close()
    return 0 if ok else 1


def _dump_nav(page) -> None:
    """Print the portal's navigation so we can map the Reports section."""
    print("Links:")
    seen = set()
    for link in page.get_by_role("link").all():
        try:
            label = (link.inner_text() or "").strip()
            href = link.get_attribute("href") or ""
        except Exception:
            continue
        if label and (label, href) not in seen:
            seen.add((label, href))
            print(f"  {label!r} -> {href}")

    print("\nButtons:")
    for btn in page.get_by_role("button").all():
        try:
            label = (btn.inner_text() or "").strip()
        except Exception:
            continue
        if label and label not in seen:
            seen.add(label)
            print(f"  {label!r}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--setup",
        action="store_true",
        help="open Chrome and wait for you to sign in manually",
    )
    ap.add_argument(
        "--auto",
        action="store_true",
        help="sign in unattended: credentials from .env, OTP from the mailbox",
    )
    args = ap.parse_args()
    if args.setup:
        return setup()
    if args.auto:
        return auto()
    return check()


def auto() -> int:
    """Unattended sign-in — reuses the saved session when it's still valid."""
    with sync_playwright() as pw:
        context, page = open_portal(pw, headed=config.HEADED)
        try:
            if is_logged_in(page):
                print(f"Existing session still valid ({page.url}) — no login needed.")
            else:
                auto_login(page)

            page.wait_for_timeout(3000)
            print(f"\nOn: {page.url}\n")
            _dump_nav(page)
            page.screenshot(path=str(config.LOGS / "after_login.png"), full_page=True)
            print(f"\nScreenshot: {config.LOGS / 'after_login.png'}")
        finally:
            context.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
