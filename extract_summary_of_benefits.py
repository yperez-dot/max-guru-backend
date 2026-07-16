"""
extract_summary_of_benefits.py

Batch-downloads and extracts text from each plan's official Summary of
Benefits PDF (linked from the 2026 Plan Comparison Grid), so Max can answer
questions using real document content instead of just a link.

WHY THIS IS A SEPARATE SCRIPT, NOT PART OF THE LIVE MAX APP:
- 113+ PDFs is too much to fetch live during a chat response (slow, costly,
  and some carrier sites rate-limit or block rapid requests)
- These documents update at most once a year (new plan year) -- no need to
  re-fetch on every query, just re-run this script periodically (e.g. each
  AEP, or whenever the plan grid's links change)

USAGE:
  pip install requests pdfplumber
  python extract_summary_of_benefits.py

INPUT: plans.json (with a "sobUrl" field per plan)
OUTPUT: sob_extracted.json -- { plan_id: { text: "...", extractedAt: "..." } }
"""

import json
import time
import re
from pathlib import Path

import requests
import pdfplumber
from io import BytesIO

INPUT_FILE = "plans.json"
OUTPUT_FILE = "sob_extracted.json"
REQUEST_DELAY_SECONDS = 1.5
TIMEOUT_SECONDS = 20
MAX_CHARS_PER_DOC = 15000


def extract_text_from_pdf_bytes(pdf_bytes: bytes) -> str:
    try:
        text_parts = []
        with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                page_text = page.extract_text()
                if page_text:
                    text_parts.append(page_text)
        text = "\n".join(text_parts)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text[:MAX_CHARS_PER_DOC]
    except Exception as e:
        print(f"  extraction failed: {e}")
        return ""


def main():
    with open(INPUT_FILE, encoding="utf-8") as f:
        plans = json.load(f)

    plans_with_links = [p for p in plans if p.get("sobUrl")]
    print(f"Found {len(plans_with_links)} plans with a Summary of Benefits link "
          f"(of {len(plans)} total plans)\n")

    results = {}
    existing = {}
    if Path(OUTPUT_FILE).exists():
        with open(OUTPUT_FILE, encoding="utf-8") as f:
            existing = json.load(f)
        print(f"Resuming -- {len(existing)} already extracted, will skip those\n")

    for i, plan in enumerate(plans_with_links, 1):
        plan_id = plan["planId"]
        url = plan["sobUrl"]

        if plan_id in existing and existing[plan_id].get("text"):
            results[plan_id] = existing[plan_id]
            continue

        print(f"[{i}/{len(plans_with_links)}] {plan['carrier']} {plan['planName']} ({plan_id})")
        try:
            resp = requests.get(url, timeout=TIMEOUT_SECONDS, headers={
                "User-Agent": "Mozilla/5.0 (compatible; THEI-internal-tool/1.0)"
            })
            resp.raise_for_status()
            text = extract_text_from_pdf_bytes(resp.content)
            if text:
                results[plan_id] = {
                    "text": text,
                    "sourceUrl": url,
                    "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                print(f"  extracted {len(text)} chars")
            else:
                print(f"  no text extracted (possibly scanned/image PDF)")
                results[plan_id] = {"text": "", "sourceUrl": url, "error": "no_text_extracted"}
        except Exception as e:
            print(f"  FAILED: {e}")
            results[plan_id] = {"text": "", "sourceUrl": url, "error": str(e)}

        with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)

        time.sleep(REQUEST_DELAY_SECONDS)

    succeeded = sum(1 for r in results.values() if r.get("text"))
    print(f"\nDone. {succeeded} of {len(plans_with_links)} extracted successfully.")
    print(f"Output written to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
