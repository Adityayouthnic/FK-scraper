"""Daily job: push yesterday's Zepto sales and today's stock into the sheet.

Two stages, in this order:
  1. Sales_F for day-2..day-1, appended to "SALES DATA-Zepto"
  2. Vendor Inventory_F, replacing "FC Inventory In Zepto"

Each report goes from the portal into the sheet in memory — no CSV is written to
disk. Everything is teed to a dated log in logs/; the exit code is non-zero on
failure, which is what Task Scheduler reports as "last result", and a failure
also emails NOTIFY_TO.

    python run_daily.py              headless (what the scheduled task uses)
    python run_daily.py --headed     show the browser, for debugging
"""

import argparse
import datetime as dt
import os
import subprocess
import sys
import time

import config
import notify

STAGES = (
    ("sales sync", ["sheet_pipeline.py", "--from-portal"]),
    # Inventory runs second, and only if sales went in: it is a snapshot that
    # replaces the tab, so there is nothing to catch up on if a day is skipped,
    # while a missed sales day is gone for good.
    ("inventory refresh", ["inventory_pipeline.py", "--from-portal"]),
)

# How much of the run's output to quote in the failure mail.
MAIL_TAIL_LINES = 40

# Everything printed this run, so the alert can quote it without re-reading the
# log file (which also holds every earlier run of the day).
_transcript: list[str] = []


def run(name: str, args: list[str], env: dict, log) -> int:
    banner = f"\n{'=' * 70}\n{name}  ({dt.datetime.now():%Y-%m-%d %H:%M:%S})\n{'=' * 70}"
    _emit(banner, log)

    proc = subprocess.Popen(
        [sys.executable, "-u", *args],
        cwd=str(config.ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    for line in proc.stdout:
        _emit(line.rstrip(), log)
    code = proc.wait()

    _emit(f"-- {name} exited {code}", log)
    return code


def _emit(text: str, log) -> None:
    print(text, flush=True)
    log.write(text + "\n")
    log.flush()
    _transcript.append(text)


def _alert(stage: str, log_path, log) -> None:
    """Mail out what went wrong, quoting the tail of this run's output."""
    tail = "\n".join(_transcript[-MAIL_TAIL_LINES:])
    body = (
        f"The Zepto daily sync failed at '{stage}' on "
        f"{dt.datetime.now():%d-%b-%Y %H:%M}.\n\n"
        f"Nothing was written to the sheet for this run.\n\n"
        f"Full log: {log_path}\n\n"
        f"Last {MAIL_TAIL_LINES} lines:\n"
        f"{'-' * 60}\n{tail}\n"
    )
    _emit("", log)
    notify.send(f"FAILED at {stage} — {dt.date.today():%d-%b-%Y}", body)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--headed", action="store_true", help="show the browser instead of hiding it"
    )
    args = ap.parse_args()

    env = dict(os.environ)
    env["HEADED"] = "1" if args.headed else "0"
    # Children default to the Windows locale encoding when their stdout is a
    # pipe, which mangles non-ASCII in the log. Pin them to UTF-8.
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"

    log_path = config.LOGS / f"daily_{dt.date.today():%Y%m%d}.log"
    started = dt.datetime.now()

    with log_path.open("a", encoding="utf-8") as log:
        _emit(f"\n\n##### run started {started:%Y-%m-%d %H:%M:%S} #####", log)

        failed_stages: list[str] = []
        for i, (name, argv) in enumerate(STAGES):
            if i > 0:
                # Give Chrome and its background processes (crashpad, profile locks)
                # time to shut down cleanly before another stage launches a browser.
                _emit(f"\nWaiting 5s before starting '{name}'...", log)
                time.sleep(5)
            try:
                code = run(name, argv, env, log)
                if code != 0:
                    failed_stages.append(f"{name} (exit {code})")
            except Exception as exc:
                failed_stages.append(f"{name} ({type(exc).__name__}: {exc})")
                _emit(f"\nFailed to run '{name}': {type(exc).__name__}: {exc}", log)

        elapsed = (dt.datetime.now() - started).total_seconds()
        if failed_stages:
            failed_desc = ", ".join(failed_stages)
            _emit(f"\nFAILED at '{failed_desc}' after {elapsed:.0f}s. Log: {log_path}", log)
            _alert(failed_desc, log_path, log)
            return 1

        _emit(f"\nOK — finished in {elapsed:.0f}s. Log: {log_path}", log)
    return 0


if __name__ == "__main__":
    sys.exit(main())
