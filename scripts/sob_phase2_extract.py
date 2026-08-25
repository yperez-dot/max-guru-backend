#!/usr/bin/env python3
"""Phase 2: batch-download + extract text from current SoB URLs in Max plan-data."""

from __future__ import annotations

import json
import re
import time
from io import BytesIO
from pathlib import Path

import pdfplumber
import requests

HTML = Path("/workspace/artifacts/max-demo-FINAL-v7.html")
OUT_DIR = Path("/tmp/sob-audit/pdfs")
OUT_JSON = Path("/workspace/artifacts/reports/sob_extracted.json")
REQUEST_DELAY = 1.2
TIMEOUT = 35
MAX_CHARS = 18000
MAX_RETRIES = 3

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)


def load_plans() -> list[dict]:
    text = HTML.read_text(encoding="utf-8")
    m = re.search(
        r'<script id="plan-data" type="application/json">\s*(.*?)\s*</script>',
        text,
        re.S,
    )
    return json.loads(m.group(1))


def drive_direct(url: str) -> str:
    m = re.search(r"/file/d/([^/]+)", url)
    if m:
        return f"https://drive.google.com/uc?export=download&id={m.group(1)}"
    return url


def extract_text(pdf_bytes: bytes) -> str:
    parts = []
    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            t = page.extract_text()
            if t:
                parts.append(t)
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(parts))
    return text[:MAX_CHARS]


def fetch(url: str, session: requests.Session) -> tuple[bytes | None, str]:
    url = drive_direct(url)
    last_err = ""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.get(
                url,
                timeout=TIMEOUT,
                headers={
                    "User-Agent": UA,
                    "Accept": "application/pdf,application/octet-stream,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    "Referer": "https://www.google.com/",
                },
                allow_redirects=True,
            )
            data = resp.content
            ctype = (resp.headers.get("content-type") or "").lower()
            if resp.status_code == 403:
                last_err = "http_403"
                time.sleep(1.5 * attempt)
                continue
            if resp.status_code >= 400:
                last_err = f"http_{resp.status_code}"
                time.sleep(0.8 * attempt)
                continue
            if data[:4] == b"%PDF":
                return data, "pdf"
            # Solis / alphadog sometimes omit magic briefly; try parse anyway
            if "pdf" in ctype or "octet" in ctype:
                try:
                    extract_text(data)
                    return data, "pdf_like"
                except Exception:
                    pass
            if b"<html" in data[:500].lower() or "text/html" in ctype:
                last_err = "html_captcha_or_page"
                time.sleep(1.2 * attempt)
                continue
            last_err = f"unknown_content:{ctype}:{data[:20]!r}"
        except Exception as e:
            last_err = str(e)
            time.sleep(1.0 * attempt)
    return None, last_err


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    plans = load_plans()
    linked = [p for p in plans if p.get("sobUrl") and str(p["sobUrl"]).startswith("http")]
    results: dict = {}
    if OUT_JSON.exists():
        results = json.loads(OUT_JSON.read_text(encoding="utf-8"))
        print(f"resuming with {len(results)} existing")

    session = requests.Session()
    for i, plan in enumerate(linked, 1):
        pid = plan.get("planId") or plan.get("id")
        key = f"{pid}|{plan.get('county')}"
        if key in results and results[key].get("text"):
            continue
        url = plan["sobUrl"]
        print(f"[{i}/{len(linked)}] {plan.get('carrier')} {pid} ({plan.get('county')})")
        data, status = fetch(url, session)
        if not data:
            results[key] = {
                "planId": pid,
                "county": plan.get("county"),
                "carrier": plan.get("carrier"),
                "planName": plan.get("planName"),
                "sourceUrl": url,
                "text": "",
                "error": status,
                "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            print(f"  FAIL {status}")
        else:
            safe = re.sub(r"[^\w.\-]+", "_", key)[:120]
            (OUT_DIR / f"{safe}.pdf").write_bytes(data)
            try:
                text = extract_text(data)
            except Exception as e:
                text = ""
                status = f"extract_failed:{e}"
            results[key] = {
                "planId": pid,
                "county": plan.get("county"),
                "carrier": plan.get("carrier"),
                "planName": plan.get("planName"),
                "sourceUrl": url,
                "text": text,
                "chars": len(text),
                "error": None if text else status or "no_text",
                "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            print(f"  ok {len(text)} chars" if text else f"  empty ({status})")

        OUT_JSON.write_text(json.dumps(results, indent=2), encoding="utf-8")
        time.sleep(REQUEST_DELAY)

    ok = sum(1 for r in results.values() if r.get("text"))
    print(f"\nDone. {ok}/{len(linked)} extracted. -> {OUT_JSON}")


if __name__ == "__main__":
    main()
