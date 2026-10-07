#!/usr/bin/env python3
"""Build data/year-compare-cms.json for Max's 2026 vs 2027 same-plan compare.

Inputs are public CMS files (download fresh each year):
  * 2027 Part C&D Plan Crosswalk  - https://www.cms.gov/files/zip/plan-crosswalk-2027.zip
  * CY2026 + CY2027 MA Landscape  - cms.gov "Landscape source files"

Only rows for plans Max knows (THEI 2027 #plan-data, archived #plan-data-2026,
and their crosswalk neighbours) in Miami-Dade / Broward are kept, so the JSON
stays small enough to inline in the UI. Then the JSON is written into the
`year-compare-cms` script block of artifacts/max-demo-FINAL-v7.html.

Usage:
  python3 scripts/build_year_compare_data.py \
    --crosswalk PlanCrosswalk2027_10012026.txt \
    --landscape-2026 CY2026_Landscape_202609.csv \
    --landscape-2027 CY2027_Landscape_202609.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HTML_PATH = REPO / "artifacts" / "max-demo-FINAL-v7.html"
OUT_PATH = REPO / "data" / "year-compare-cms.json"
COUNTIES = ("Miami-Dade", "Broward")
BLOCK_ID = "year-compare-cms"


def norm_id(raw: str) -> str | None:
    """H1036-054C / H129-002 / H1045-012-000 / H5420-001/0028 -> H1036-054."""
    m = re.search(r"\b([HRS])\s*(\d{3,4})\s*[-_ ]\s*(\d{1,3})", str(raw or "").upper())
    if not m:
        return None
    contract = m.group(2)
    if len(contract) == 3:  # Devoted "H129-002" typo in the 2026 grid
        contract += "0"
    return f"{m.group(1)}{contract}-{int(m.group(3)):03d}"


def read_block(html: str, block_id: str):
    m = re.search(
        r'<script id="%s" type="application/json">\s*(.*?)\s*</script>' % re.escape(block_id), html, re.S
    )
    return json.loads(m.group(1)) if m else None


def write_block(html: str, block_id: str, data, after_id: str) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    tag = f'<script id="{block_id}" type="application/json">{payload}</script>'
    pat = re.compile(r'<script id="%s" type="application/json">.*?</script>' % re.escape(block_id), re.S)
    if pat.search(html):
        return pat.sub(lambda _m: tag, html, count=1)
    anchor = re.search(r'<script id="%s" type="application/json">.*?</script>' % re.escape(after_id), html, re.S)
    if not anchor:
        raise SystemExit(f"{after_id} block missing")
    return html[: anchor.end()] + "\n" + tag + html[anchor.end():]


def money(raw: str):
    s = str(raw or "").strip()
    if not s or s.lower().startswith("not applicable"):
        return None
    m = re.search(r"([\d,]+(?:\.\d+)?)", s)
    if not m:
        return None
    v = float(m.group(1).replace(",", ""))
    return f"${v:,.2f}".replace(".00", "")


def load_landscape(path: Path, wanted: set[str]) -> dict:
    out: dict = {}
    with path.open(encoding="latin-1", newline="") as fh:
        reader = csv.reader(fh)
        header = [re.sub(r"^[^A-Za-z]+", "", h) for h in next(reader)]
        ix = {h: i for i, h in enumerate(header)}
        for row in reader:
            if row[ix["State Territory Abbreviation"]] != "FL":
                continue
            county = row[ix["County Name"]]
            if county not in COUNTIES:
                continue
            pid = f"{row[ix['Contract ID']]}-{row[ix['Plan ID']].zfill(3)}"
            if pid not in wanted:
                continue
            key = f"{pid}|{county}"
            seg = row[ix["Segment ID"]] or "0"
            if key in out and seg != "0":
                continue
            star = (row[ix["Overall Star Rating"]] or "").strip()
            out[key] = {
                "planName": row[ix["Plan Name"]].strip(),
                "planType": row[ix["Plan Type"]].strip(),
                "snpType": row[ix["SNP Type"]].strip(),
                "premium": money(row[ix["Monthly Consolidated Premium (Part C + D)"]])
                or money(row[ix["Part C Premium"]]),
                "moop": money(row[ix["In-Network Maximum Out-of-Pocket (MOOP) Amount"]]),
                "partDDeductible": money(row[ix["Annual Part D Deductible Amount"]]),
                "starRating": star or None,
            }
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--crosswalk", type=Path, required=True)
    ap.add_argument("--landscape-2026", type=Path, required=True)
    ap.add_argument("--landscape-2027", type=Path, required=True)
    ap.add_argument("--crosswalk-label", default="CMS 2027 Part C&D Plan Crosswalk (file dated 10/01/2026)")
    ap.add_argument("--landscape-2026-label", default="CMS CY2026 Landscape (202609)")
    ap.add_argument("--landscape-2027-label", default="CMS CY2027 Landscape (202609.1)")
    ap.add_argument("--no-html", action="store_true", help="only write data/year-compare-cms.json")
    args = ap.parse_args()

    html = HTML_PATH.read_text(encoding="utf-8")
    p27 = read_block(html, "plan-data") or []
    p26 = read_block(html, "plan-data-2026") or []
    ids27 = {norm_id(p.get("planId") or p.get("id")) for p in p27} - {None}
    ids26 = {norm_id(p.get("planId") or p.get("id")) for p in p26} - {None}
    known = ids27 | ids26

    rows = []
    with args.crosswalk.open(encoding="latin-1", newline="") as fh:
        for r in csv.DictReader(fh, delimiter="\t"):
            prev = f"{r['PREVIOUS_CONTRACT_ID']}-{r['PREVIOUS_PLAN_ID'].zfill(3)}" if r["PREVIOUS_CONTRACT_ID"] else ""
            cur = f"{r['CURRENT_CONTRACT_ID']}-{r['CURRENT_PLAN_ID'].zfill(3)}" if r["CURRENT_CONTRACT_ID"] else ""
            prev = "" if prev.endswith("-NEW") else prev
            cur = "" if cur.startswith("TERMINATED") else cur
            if prev not in known and cur not in known:
                continue
            rows.append(
                {
                    "prev": prev or None,
                    "prevName": (r["PREVIOUS_PLAN_NAME"] or "").strip() if prev else None,
                    "prevSnp": (r["PREVIOUS_SNP_TYPE"] or "").strip() or None,
                    "cur": cur or None,
                    "curName": (r["CURRENT_PLAN_NAME"] or "").strip() if cur else None,
                    "curSnp": (r["CURRENT_SNP_TYPE"] or "").strip() or None,
                    "status": r["STATUS"].strip(),
                }
            )
    rows.sort(key=lambda x: (x["cur"] or "~", x["prev"] or ""))
    neighbours = known | {r["prev"] for r in rows if r["prev"]} | {r["cur"] for r in rows if r["cur"]}

    data = {
        "sources": {
            "crosswalk": args.crosswalk_label,
            "landscape2026": args.landscape_2026_label,
            "landscape2027": args.landscape_2027_label,
        },
        "crosswalk": rows,
        "landscape": {
            "2026": load_landscape(args.landscape_2026, neighbours),
            "2027": load_landscape(args.landscape_2027, neighbours),
        },
    }
    OUT_PATH.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"wrote {OUT_PATH.relative_to(REPO)}: crosswalk rows={len(rows)} "
        f"landscape 2026={len(data['landscape']['2026'])} 2027={len(data['landscape']['2027'])}"
    )
    if not args.no_html:
        html = write_block(html, BLOCK_ID, data, after_id="plan-data-2026")
        HTML_PATH.write_text(html, encoding="utf-8")
        print(f"synced #{BLOCK_ID} into {HTML_PATH.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
