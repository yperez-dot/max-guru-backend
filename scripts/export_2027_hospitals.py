#!/usr/bin/env python3
"""Export the 2027 THEI grid 'Hospitals x Carrier' tab into data/hospitals-x-carrier-2027.json
and max-knowledge/carriers/hospital-networks-2027.md.

Same workbook as export_2027_grid_to_kb.py / export_2027_plan_info_to_kb.py
(/tmp/thei-2027-grid.xlsx). Read-only on the sheet. Re-run after Yahoska edits
the Hospitals x Carrier tab (Baptist PCPs, UM PCP, hospital Yes/No).

The JSON is Max's 2027 source of truth for hospital and PCP-row questions.
UM's public Insurance Plans Accepted page is stored only as umSiteSupplement
(carriers the grid has no column for, plus plan IDs that agree with the grid).
The grid wins on every overlapping carrier. 2026 hospital-networks.md is not
touched.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from thei_grid_common import SHEET_ID_2027 as SHEET_ID, require_xlsx  # noqa: E402

JSON_PATH = REPO_ROOT / "data" / "hospitals-x-carrier-2027.json"
KB_PATH = REPO_ROOT / "max-knowledge" / "carriers" / "hospital-networks-2027.md"
GID = "369609513"
TAB = "Hospitals x Carrier"
WORKBOOK = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit?gid={GID}"


def clean(v) -> str:
    if v is None:
        return ""
    return re.sub(r"\s+", " ", str(v).replace("\r", "").replace("\n", " ")).strip()


def kind_of(name: str) -> str:
    u = name.upper()
    if u.endswith("PCP") or u.endswith("PCPS"):
        return "pcp"
    return "hospital"


def parse(xlsx: Path) -> tuple[list[str], list[dict]]:
    import openpyxl

    wb = openpyxl.load_workbook(xlsx, data_only=True)
    if TAB not in wb.sheetnames:
        raise SystemExit(f"no '{TAB}' tab in the workbook")
    ws = wb[TAB]
    rows_iter = list(ws.iter_rows(values_only=True))
    if not rows_iter:
        raise SystemExit(f"empty '{TAB}' tab")
    header = [clean(h) for h in rows_iter[0]]
    if not header or header[0].lower() not in ("hospital", "hospitals"):
        raise SystemExit(f"unexpected '{TAB}' header: {header[:4]!r}")
    carriers = [h for h in header[1:] if h]
    out = []
    for raw in rows_iter[1:]:
        name = clean(raw[0]) if raw else ""
        if not name:
            continue
        by = {}
        for i, col in enumerate(carriers, start=1):
            by[col] = clean(raw[i]) if i < len(raw) else ""
        out.append({"hospital": name, "kind": kind_of(name), "byCarrier": by})
    return carriers, out


def merge_into_json(carriers: list[str], rows: list[dict], pulled: str) -> dict:
    prev = {}
    if JSON_PATH.exists():
        try:
            prev = json.loads(JSON_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            prev = {}
    data = {
        "about": (
            "THEI 2027 Plan Comparison Grid, Hospitals x Carrier tab. Yes/No per carrier. "
            "PCP questions use the Baptist PCPs and UM PCP rows; hospital questions use "
            "Baptist Hospital / University of Miami and the other hospital rows. "
            "Grid wins over any other 2027 hospital source."
        ),
        "year": 2027,
        "source": {
            "kind": "thei-grid",
            "workbook": WORKBOOK,
            "sheetId": SHEET_ID,
            "gid": GID,
            "tab": TAB,
            "pulled": pulled,
        },
        "carriers": carriers,
        "rows": rows,
    }
    # Keep the UM public-page supplement: it is not on the grid tab.
    if isinstance(prev.get("umSiteSupplement"), dict):
        data["umSiteSupplement"] = prev["umSiteSupplement"]
    return data


def yes_of(row: dict) -> list[str]:
    return [c for c, v in (row.get("byCarrier") or {}).items() if str(v).lower().startswith("yes")]


def render_kb(data: dict) -> str:
    src = data["source"]
    pulled = src.get("pulled", "")
    lines = [
        "# Hospital networks — 2027 (Florida)",
        "",
        f"Source: THEI 2027 Plan Comparison Grid — **{src.get('tab')}** tab",
        f"Workbook: {src.get('workbook')}",
        f"Pulled: {pulled}",
        "",
        "This is the **2027** hospital × carrier Yes/No matrix. Live Max answers 2027 hospital "
        "and PCP-row questions from `data/hospitals-x-carrier-2027.json` (this tab). "
        "The 2026 table in `hospital-networks` is unchanged — use it only for a 2026-only ask.",
        "",
        "**PCP vs hospital:** `Baptist PCPs` and `UM PCP` are primary-care rows. "
        "`Baptist Hospital` and `University of Miami` are hospital rows. Do not answer a PCP "
        "question from a hospital row, or a hospital question from a PCP row.",
        "",
        "A cell that starts with **Yes** is in network. **No** is out. A blank cell is not on "
        "the grid — do not invent Yes or No.",
        "",
        "Refresh: `python3 scripts/export_2027_hospitals.py` (same `/tmp/thei-2027-grid.xlsx` as the other 2027 grid exporters).",
        "",
        "## PCP rows (2027)",
        "",
    ]
    for row in data["rows"]:
        if row.get("kind") != "pcp":
            continue
        yes = yes_of(row)
        no = [c for c, v in row["byCarrier"].items() if str(v).lower().startswith("no")]
        lines.append(f"### {row['hospital']}")
        lines.append("")
        lines.append(f"- **Yes:** {', '.join(yes) if yes else 'none'}")
        lines.append(f"- **No:** {', '.join(no) if no else 'none'}")
        lines.append("")
    lines += [
        "## University of Miami hospital (not PCP)",
        "",
    ]
    um = next((r for r in data["rows"] if r["hospital"] == "University of Miami"), None)
    if um:
        lines.append(f"- **Yes:** {', '.join(yes_of(um)) or 'none'}")
        lines.append(
            "- Humana is **Yes** for the UM *hospital* and **No** on the UM PCP row "
            "(specialty + UMHC, no UM primary care)."
        )
        lines.append("")
    supp = data.get("umSiteSupplement") or {}
    extra = supp.get("extraCarriers") or []
    if extra:
        src_u = supp.get("source") or {}
        lines += [
            "## Extra carriers from UHealth's site (no grid column)",
            "",
            f"Source: {src_u.get('url', '')} (fetched {src_u.get('fetched', '')}, {src_u.get('tab', '')}). "
            "The grid has no column for these carriers. Label the answer as from UM's site. "
            "Never invent participation for a plan that is not in this file.",
            "",
        ]
        for e in extra:
            pcp = "Yes" if e.get("pcp") else "No"
            lines.append(
                f"- **{e['carrier']}** ({', '.join(e.get('counties') or [])}): "
                f"UM PCP {pcp}; UM specialty {'Yes' if e.get('specialty') else 'No'}; "
                f"UM hospital {'Yes' if e.get('hospital') else 'No'}. Plans: {'; '.join(e.get('plans') or [])}."
            )
        lines.append("")
        unmatched = supp.get("unmatchedToTheiGrid") or []
        if unmatched:
            lines.append("UM-listed plans with no 2027 THEI grid match (do not invent a contract-PBP):")
            lines.append("")
            for u in unmatched:
                lines.append(f"- {u.get('listedAs')} — {u.get('reason')}")
            lines.append("")
    lines += [
        "## Full lookup table",
        "",
        "| Hospital | Kind | Carriers in-network (Yes) |",
        "|----------|------|---------------------------|",
    ]
    for row in data["rows"]:
        lines.append(f"| {row['hospital']} | {row.get('kind', 'hospital')} | {', '.join(yes_of(row)) or '—'} |")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--xlsx", type=Path, default=Path("/tmp/thei-2027-grid.xlsx"))
    ap.add_argument(
        "--from-json",
        action="store_true",
        help="rebuild the KB markdown from the committed JSON (no xlsx)",
    )
    args = ap.parse_args()
    if args.from_json:
        data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    else:
        require_xlsx(args.xlsx)
        carriers, rows = parse(args.xlsx)
        pulled = datetime.now(timezone.utc).strftime("%m.%Y")
        # Prefer MM.YYYY in the JSON when this script is the pull; the live
        # agent-facing date format in this repo is MM.YYYY.
        data = merge_into_json(carriers, rows, pulled)
        JSON_PATH.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {JSON_PATH} ({len(rows)} rows, {len(carriers)} carriers)")
    KB_PATH.write_text(render_kb(data), encoding="utf-8")
    print(f"wrote {KB_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
