#!/usr/bin/env python3
"""Sync sobUrl on Max plan-data from THEI grid Summary of Benefits hyperlinks."""

from __future__ import annotations

import json
import re
from pathlib import Path

import openpyxl

HTML = Path("/workspace/artifacts/max-demo-FINAL-v7.html")
XLSX = Path("/tmp/thei-grid.xlsx")

SHEETS = [
    ("DADE- HMO", "Miami-Dade"),
    ("BWD- HMO", "Broward"),
    ("DADE-CSNP", "Miami-Dade"),
    ("BWD-CSNP", "Broward"),
    ("Dade- DSNP", "Miami-Dade"),
    ("BWD-DSNP", "Broward"),
    ("DADE- Giveback", "Miami-Dade"),
    ("BWD-Giveback", "Broward"),
    ("DADE-PPO", "Miami-Dade"),
    ("BWD-PPO", "Broward"),
]


def extract_plan_id(header) -> str | None:
    if not header:
        return None
    s = str(header).replace("‑", "-").replace("–", "-")
    m = re.search(
        r"\b([HR]\d{3,4})\s*[|\-]?\s*(\d{2,4}[A-Z]?)(?:\s*(?:FL[-\s]?(\d{2,4})|[/\-](\d{1,4})))?",
        s,
        re.I,
    )
    if not m:
        m = re.search(r"\b([HR]\d{3})\s*-\s*(\d{2,4}[A-Z]?)", s, re.I)
    if not m:
        return None
    base = f"{m.group(1).upper()}-{m.group(2)}"
    if m.lastindex and m.lastindex >= 3 and m.group(3):
        return f"{base}-FL-{m.group(3)}" if re.search(r"FL", s, re.I) else f"{base}-{m.group(3)}"
    if m.lastindex and m.lastindex >= 4 and m.group(4):
        return f"{base}/{m.group(4)}" if "/" in s else f"{base}-{m.group(4)}"
    return base


def compact(s: str) -> str:
    return re.sub(r"[\s/\-_]+", "", str(s or "").upper())


def cell_url(cell) -> str | None:
    if cell.hyperlink and cell.hyperlink.target:
        return cell.hyperlink.target.strip()
    val = cell.value
    if isinstance(val, str) and val.strip().startswith("http"):
        return val.strip()
    if isinstance(val, str) and "HYPERLINK" in val.upper():
        m = re.search(r'HYPERLINK\("([^"]+)"', val, re.I)
        if m:
            return m.group(1)
    return None


def main() -> None:
    text = HTML.read_text(encoding="utf-8")
    m = re.search(
        r'<script id="plan-data" type="application/json">\s*(.*?)\s*</script>',
        text,
        re.S,
    )
    plans = json.loads(m.group(1))
    wb = openpyxl.load_workbook(XLSX, data_only=False)

    grid = []
    for sheet, county in SHEETS:
        ws = wb[sheet]
        rows = list(ws.iter_rows())
        sob_row = None
        for i, r in enumerate(rows):
            lab = r[0].value
            if lab and "summary of" in str(lab).lower().replace("\n", " "):
                sob_row = i
                break
        if sob_row is None:
            continue
        for col in range(1, len(rows[0])):
            h = rows[0][col].value
            if not h:
                continue
            pid = extract_plan_id(h)
            if not pid:
                continue
            url = cell_url(rows[sob_row][col])
            if url and url.startswith("http"):
                grid.append((pid, county, url))

    def find_plan(pid, county):
        cands = [p for p in plans if p.get("county") == county]
        for p in cands:
            ids = [p.get("planId"), p.get("id")]
            if any(x and (x == pid or compact(x) == compact(pid)) for x in ids):
                return p
        for p in cands:
            ids = [str(p.get("planId") or ""), str(p.get("id") or "")]
            if any(compact(pid) in compact(x) or compact(x) in compact(pid) for x in ids if x):
                return p
        return None

    filled = updated = 0
    for pid, county, url in grid:
        p = find_plan(pid, county)
        if not p:
            continue
        cur = p.get("sobUrl")
        if cur == url:
            continue
        if not cur or not str(cur).startswith("http"):
            p["sobUrl"] = url
            filled += 1
        elif url.lower().endswith(".pdf") and not str(cur).lower().endswith(".pdf"):
            p["sobUrl"] = url
            updated += 1

    HTML.write_text(
        text[: m.start(1)]
        + json.dumps(plans, ensure_ascii=False, separators=(",", ":"))
        + text[m.end(1) :],
        encoding="utf-8",
    )
    with_url = sum(1 for p in plans if p.get("sobUrl") and str(p.get("sobUrl")).startswith("http"))
    print(f"filled={filled} updated={updated} coverage={with_url}/{len(plans)}")


if __name__ == "__main__":
    main()
