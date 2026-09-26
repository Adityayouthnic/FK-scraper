"""Shared paths and settings, loaded from .env, credentials.json, and environment."""

import json
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).parent
DATA_DIR = ROOT.parent / "data"
CREDS_FILE = DATA_DIR / "credentials.json"
LEGACY_DIR = Path(r"C:\Tools 2.0\Zepto_Auto_sale")

# 1. Load local .env if present
load_dotenv(ROOT / ".env")
load_dotenv(ROOT.parent / ".env")

# 2. Fallback to C:\Tools 2.0\Zepto_Auto_sale\.env if present
if LEGACY_DIR.exists() and (LEGACY_DIR / ".env").exists():
    load_dotenv(LEGACY_DIR / ".env")

# 3. Read from data/credentials.json if present
creds_data = {}
if CREDS_FILE.exists():
    try:
        creds_data = json.loads(CREDS_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass

DOWNLOADS = ROOT / "downloads"
LOGS = ROOT / "logs"

# Resolve SECRETS directory: check environment, local secrets, legacy secrets
env_secrets = os.getenv("ZEPTO_SECRETS_DIR")
if env_secrets and Path(env_secrets).exists():
    SECRETS = Path(env_secrets)
elif (ROOT / "secrets" / "google_token.json").exists() or (ROOT / "secrets" / "chrome_profile").exists():
    SECRETS = ROOT / "secrets"
elif LEGACY_DIR.exists() and (LEGACY_DIR / "secrets").exists():
    SECRETS = LEGACY_DIR / "secrets"
else:
    SECRETS = ROOT / "secrets"

# Playwright reuses this so we don't log in from scratch on every run.
STATE_FILE = SECRETS / "storage_state.json"

BASE_URL = os.getenv("ZEPTO_BASE_URL", "https://brands.zepto.co.in")
LOGIN_URL = f"{BASE_URL}/login"

EMAIL = os.getenv("ZEPTO_EMAIL") or creds_data.get("zeptoEmail") or ""
PASSWORD = os.getenv("ZEPTO_PASSWORD") or creds_data.get("zeptoPassword") or ""
GSHEET_ID = os.getenv("GSHEET_ID") or creds_data.get("zeptoSheetId") or ""
HEADED = os.getenv("HEADED", "0") == "1"

# Mailbox that receives the login OTP.
IMAP_HOST = os.getenv("IMAP_HOST") or creds_data.get("zeptoImapHost") or "imap.gmail.com"
IMAP_USER = os.getenv("IMAP_USER") or creds_data.get("zeptoImapUser") or ""
raw_imap_pw = os.getenv("IMAP_PASSWORD") or creds_data.get("zeptoImapPassword") or ""
IMAP_PASSWORD = raw_imap_pw.replace(" ", "")

# Where failure alerts go.
SMTP_HOST = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT = int(os.getenv("SMTP_PORT", "465"))
notify_to_env = os.getenv("NOTIFY_TO") or creds_data.get("zeptoNotifyTo") or IMAP_USER
NOTIFY_TO = [
    a.strip()
    for a in notify_to_env.split(",")
    if a.strip()
]

for d in (DOWNLOADS, LOGS, ROOT / "secrets"):
    d.mkdir(exist_ok=True)
