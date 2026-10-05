#!/usr/bin/env python3
"""Sync THEI plan comparison grid (xlsx) into Max plan-data JSON.

Default / `--year 2026`: merge-update live `#plan-data` from the 2026 workbook
(`/tmp/thei-grid.xlsx`).

`--year 2027`: rebuild live `#plan-data` from the 2027 working workbook
https://docs.google.com/spreadsheets/d/1BYhBfOzdeJOMEVXIKJkHrZzEohrOBR-N
(non-yellow cells only). Yellow leftover cells are never copied as confirmed
2027 dollars. Archives the previous 2026 `#plan-data` to
`artifacts/plan-data-2026.json` and `#plan-data-2026` when missing.

Never sync from the finished client-comps archive.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

import openpyxl

REPO_ROOT = Path(__file__).resolve().parents[1]
HTML_PATH = REPO_ROOT / "artifacts" / "max-demo-FINAL-v7.html"
XLSX_PATH = Path("/tmp/thei-grid.xlsx")
XLSX_2027_PATH = Path("/tmp/thei-2027-grid.xlsx")
ARCHIVE_2026_PATH = REPO_ROOT / "artifacts" / "plan-data-2026.json"

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dental_procedure_rows import (  # noqa: E402
    apply_curated_on_plan_objects,
    apply_sibling_dental_on_plan_objects,
    is_clear_dental_value,
    is_junk_dental_value,
    DENTAL_FIELD_KEYS,
)
from thei_grid_common import (  # noqa: E402
    SHEET_ID_2027,
    carrier_of as carrier_of_2027,
    extract_plan_id as extract_plan_id_common,
    is_confirmed_2027_cell,
    is_healthspring_dade_broward,
    is_yellow,
    resolve_2027_sheets,
)

SHEETS = [
    ("DADE- HMO", "Miami-Dade", "HMO"),
    ("BWD- HMO", "Broward", "HMO"),
    ("DADE-CSNP", "Miami-Dade", "C-SNP"),
    ("BWD-CSNP", "Broward", "C-SNP"),
    ("Dade- DSNP", "Miami-Dade", "D-SNP"),
    ("BWD-DSNP", "Broward", "D-SNP"),
    ("DADE- Giveback", "Miami-Dade", "HMO"),
    ("BWD-Giveback", "Broward", "HMO"),
    ("DADE-PPO", "Miami-Dade", "PPO"),
    ("BWD-PPO", "Broward", "PPO"),
]

LABEL_MAP = {
    "premium": "premium",
    "part b giveback": "partBGiveback",
    "part b give back": "partBGiveback",
    "part b rebate": "partBGiveback",
    "referrals needed?": "referral",
    "max out of pocket": "moop",
    "inpatient hospital": "inpatientHospital",
    "outpatient hospital": "outpatientHospital",
    "outpatient": "outpatientHospital",
    "pcp": "pcpCopay",
    "specialist": "specialistCopay",
    "er": "erCopay",
    "urgent care": "urgentCareCopay",
    "advanced imaging (mri, ct, pet)": "advancedImaging",
    "advanced imaging": "advancedImaging",
    "hearing services": "hearing",
    "dental": "dental",
    "deep cleaning": "dentalDeepCleaning",
    "dentures": "dentalDentures",
    "fillings": "dentalFillings",
    "root canals": "dentalRootCanals",
    "extractions": "dentalExtractions",
    "crowns": "dentalCrowns",
    "bridges": "dentalBridges",
    "implants": "dentalImplants",
    "dental implants": "dentalImplants",
    "vision allowance": "vision",
    "ambulance": "ambulance",
    "transportation": "transportation",
    "rx deductible": "rxDeductible",
    "tier 1": "tier1",
    "tier 2": "tier2",
    "tier 3": "tier3",
    "tier 4": "tier4",
    "tier 5": "tier5",
    "tier 6": "tier6",
    "otc": "otc",
    "acupuncture": "acupuncture",
    "fitness": "fitness",
    "grocery card": "groceryCardDetail",
    "chronic conditions": "chronicConditions",
    "ssbci chronic conditions": "chronicConditions",
    "custodial care": "custodialCare",
    "other": "other",
    "msp levels": "mspLevels",
    "deductible": "planDeductible",
    "plan deductible": "planDeductible",
    "companionship": "companionship",
    "star ratings": "starRating",
    "star rating": "starRating",
}

MONEY_STRING_FIELDS = {"premium", "moop", "vision"}


def norm_label(s: object) -> str:
    if s is None:
        return ""
    s = str(s).replace("\n", " ").strip().lower()
    return re.sub(r"\s+", " ", s)


def extract_plan_id(header: object) -> str | None:
    """Extract CMS-style plan id from a sheet header cell."""
    if not header:
        return None
    s = str(header).replace("‑", "-").replace("–", "-")
    # H1032 | 206
    m = re.search(r"\b([HR]\d{3,4})\s*\|\s*(\d{2,4})\b", s, re.I)
    if m:
        return f"{m.group(1).upper()}-{m.group(2)}"
    # H1036-054C / H5471-077-00 / H1290-019-000 / H5420-003 FL-0029 / H5420-001/ 0028
    m = re.search(
        r"\b([HR]\d{3,4})\s*-\s*(\d{2,4}[A-Z]?)(?:\s*(?:FL-?)(\d{2,4})|\s*-\s*(\d{1,4})|\s*/\s*-?\s*(\d{2,4}))?",
        s,
        re.I,
    )
    if not m:
        # short Devoted-style H129-002
        m = re.search(
            r"\b([HR]\d{3})\s*-\s*(\d{2,4}[A-Z]?)(?:\s*-\s*(\d{1,4}))?",
            s,
            re.I,
        )
        if not m:
            return None
        base = f"{m.group(1).upper()}-{m.group(2)}"
        if m.lastindex and m.lastindex >= 3 and m.group(3):
            return f"{base}-{m.group(3)}"
        return base

    base = f"{m.group(1).upper()}-{m.group(2)}"
    if m.group(3):  # FL-0029
        return f"{base}-FL-{m.group(3)}"
    if m.group(4):  # -000 / -0
        return f"{base}-{m.group(4)}"
    if m.group(5):  # /0028
        return f"{base}/{m.group(5)}"
    return base


def parse_header_meta(header: object) -> tuple[str | None, str, str]:
    s = str(header).strip()
    lines = [ln.strip() for ln in s.split("\n") if ln.strip()]
    pid = extract_plan_id(s)
    carrier = lines[0].split()[0] if lines else "Unknown"
    name_parts: list[str] = []
    for ln in lines:
        cleaned = re.sub(
            r"\b[HR]\d{3,4}\s*[|\-]\s*\d{2,4}[A-Z]?(?:\s*(?:FL-?\d{2,4}|-\s*\d{1,4}|/\s*-?\s*\d{2,4}))?",
            "",
            ln.replace("‑", "-"),
            flags=re.I,
        ).strip(" -*")
        cleaned = re.sub(r"\s+", " ", cleaned).strip()
        if cleaned:
            name_parts.append(cleaned)
    plan_name = " ".join(name_parts[:4]).strip() or (lines[0] if lines else pid or "Unknown")
    plan_name = re.sub(r"\s+", " ", plan_name)
    for key, nice in [
        ("UHC", "UHC"),
        ("United", "UHC"),
        ("Preferred", "UHC"),
        ("Doctors", "Doctors"),
        ("CarePlus", "CarePlus"),
        ("CareOne", "CarePlus"),
        ("CareNeeds", "CarePlus"),
        ("CareFree", "CarePlus"),
        ("CareBreeze", "CarePlus"),
        ("CareComplete", "CarePlus"),
        ("CareAccess", "CarePlus"),
        ("Devoted", "Devoted"),
        ("Aetna", "Aetna"),
        ("Humana", "Humana"),
        ("Simply", "Simply"),
        ("HealthSun", "HealthSun"),
        ("Wellcare", "Wellcare"),
        ("WellCare", "Wellcare"),
        ("Freedom", "Freedom"),
        ("Optimum", "Optimum"),
        ("Molina", "Molina"),
        ("Cigna", "Cigna"),
        ("Medica", "Medica"),
    ]:
        if plan_name.startswith(key) or carrier.startswith(key) or key in str(header):
            carrier = nice
            break
    return pid, carrier, plan_name


def convert_value(field: str, val: object):
    if val is None:
        return None
    if isinstance(val, str):
        s = val.strip()
        if not s:
            return None
        if norm_label(s).startswith("summary of"):
            return None
        return s
    if isinstance(val, (int, float)):
        f = float(val)
        if 0 < abs(f) < 1:
            return f
        if f == int(f):
            return int(f)
        return f
    return val


def money_num(x) -> float | None:
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str):
        m = re.fullmatch(r"\$?\s*([\d,]+(?:\.\d+)?)", x.strip())
        if m:
            return float(m.group(1).replace(",", ""))
    return None


def values_equal(a, b) -> bool:
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return float(a) == float(b)
    na, nb = money_num(a), money_num(b)
    if na is not None and nb is not None:
        return na == nb
    return str(a).strip() == str(b).strip()


def format_money_string(field: str, n: float, cur) -> object:
    if isinstance(cur, str) and values_equal(cur, n):
        return cur
    whole = float(n) == int(n)
    iv = int(n) if whole else n
    if field == "premium":
        return f"${iv}"
    if field in ("moop", "vision"):
        return f"${iv:,}" if whole else f"${iv}"
    return n


def prefer_store(field: str, grid_val, cur_val):
    if grid_val is None:
        return cur_val
    if field in MONEY_STRING_FIELDS and isinstance(grid_val, (int, float)):
        return format_money_string(field, float(grid_val), cur_val)
    return grid_val


def compact_id(s: str) -> str:
    return re.sub(r"[\s/\-_]+", "", str(s or "").upper())


def id_tokens(s: str) -> set[str]:
    """Matching keys for a plan id string.

    Keep tokens precise: H4140-012 must NOT collide with H4140-001.
    Allow only safe softenings: letter PBP suffix (054C→054), trailing -000/-00,
    and /0028 dual-segment forms.
    """
    raw = str(s or "").replace("‑", "-").replace("–", "-")
    tokens: set[str] = set()
    if raw.strip():
        tokens.add(compact_id(raw))

    # Slug ids: pull out embedded CMS-looking ids
    for m in re.finditer(
        r"([HR]\d{3,4})\s*[|\-]?\s*(\d{2,4}[A-Z]?)(?:\s*(?:FL[-\s]?(\d{2,4})|[/\-](\d{1,4})))?",
        raw,
        re.I,
    ):
        contract = m.group(1).upper()
        pbp = m.group(2).upper()
        base = f"{contract}-{pbp}"
        tokens.add(compact_id(base))
        # letter suffix softening: 054C → 054
        if re.search(r"[A-Z]$", pbp):
            tokens.add(compact_id(f"{contract}-{pbp[:-1]}"))
        if m.group(3):  # FL-0029
            tokens.add(compact_id(f"{base}-FL-{m.group(3)}"))
            tokens.add(compact_id(f"{base}/{m.group(3)}"))
        if m.group(4):  # -000 or /0028
            extra = m.group(4)
            tokens.add(compact_id(f"{base}-{extra}"))
            tokens.add(compact_id(f"{base}/{extra}"))
            # trailing zero-pad segment softens to base (H5471-077-00 → H5471-077)
            if re.fullmatch(r"0+", extra):
                tokens.add(compact_id(base))
    return {t for t in tokens if t}


def parse_grid(xlsx: Path) -> list[dict]:
    wb = openpyxl.load_workbook(xlsx, data_only=True)
    grid_plans: list[dict] = []
    for sheet, county, ptype in SHEETS:
        ws = wb[sheet]
        rows = list(ws.iter_rows(values_only=True))
        if not rows:
            continue
        header = rows[0]
        label_rows: list[tuple[int, str]] = []
        for i, r in enumerate(rows[1:], start=1):
            lab = norm_label(r[0])
            if not lab or lab.startswith("summary of") or lab == "note":
                continue
            key = LABEL_MAP.get(lab)
            if not key:
                lab2 = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ?]+", "", lab)).strip()
                key = LABEL_MAP.get(lab2)
            if key:
                label_rows.append((i, key))

        for col in range(1, len(header)):
            h = header[col]
            if h is None or not str(h).strip():
                continue
            pid, carrier, plan_name = parse_header_meta(h)
            if not pid:
                continue
            fields: dict = {}
            for i, key in label_rows:
                raw = rows[i][col] if col < len(rows[i]) else None
                val = convert_value(key, raw)
                if val is None:
                    continue
                if key == "other" and fields.get("other"):
                    fields["other"] = f"{fields['other']}\n{val}"
                else:
                    fields[key] = val
            grid_plans.append(
                {
                    "id": pid,
                    "planId": pid,
                    "carrier": carrier,
                    "planName": plan_name,
                    "county": county,
                    "type": ptype,
                    "fields": fields,
                }
            )
    return grid_plans


def find_matches(plans: list[dict], gp: dict, by_token: dict) -> list[dict]:
    tokens = id_tokens(gp["id"])
    hits: list[dict] = []
    seen = set()
    for tok in tokens:
        for p in by_token.get(tok, []):
            i = id(p)
            if i not in seen:
                seen.add(i)
                hits.append(p)
    county_hits = [p for p in hits if p.get("county") == gp["county"]]
    if county_hits:
        hits = county_hits

    def score(p: dict) -> tuple:
        pid = str(p.get("planId") or p.get("id") or "")
        exact = 1 if compact_id(pid) == compact_id(gp["id"]) else 0
        # shared exact CMS base without soft extras
        overlap = len(id_tokens(pid) & tokens)
        cms = 1 if re.match(r"^[HR]\d{3,4}-", pid) else 0
        type_match = (
            1
            if str(p.get("type", "")).upper().replace("-", "")
            == gp["type"].upper().replace("-", "")
            else 0
        )
        return (exact, overlap, cms, type_match)

    if hits:
        best = max(score(p) for p in hits)
        hits = [p for p in hits if score(p) == best]
    return hits


def rebuild_token_index(plans: list[dict]) -> dict:
    by_token: dict[str, list] = defaultdict(list)
    for p in plans:
        for tok in id_tokens(str(p.get("planId") or "")) | id_tokens(str(p.get("id") or "")):
            by_token[tok].append(p)
    return by_token


def read_plan_data_block(html: str, script_id: str = "plan-data"):
    m = re.search(
        rf'<script id="{re.escape(script_id)}" type="application/json">\s*(.*?)\s*</script>',
        html,
        re.S,
    )
    if not m:
        return None, None
    return m, json.loads(m.group(1))


def replace_or_insert_script_json(html: str, script_id: str, obj, after_id: str | None = None) -> str:
    payload = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    pat = rf'(<script id="{re.escape(script_id)}" type="application/json">)\s*.*?\s*(</script>)'
    if re.search(pat, html, re.S):
        return re.sub(pat, lambda m: m.group(1) + payload + m.group(2), html, count=1, flags=re.S)
    block = f'<script id="{script_id}" type="application/json">{payload}</script>\n'
    if after_id:
        after = rf'(<script id="{re.escape(after_id)}" type="application/json">\s*.*?\s*</script>)'
        if re.search(after, html, re.S):
            return re.sub(after, lambda m: m.group(1) + "\n" + block, html, count=1, flags=re.S)
    return html.replace("</head>", block + "</head>", 1)


def parse_grid_2027(xlsx: Path) -> list[dict]:
    wb = openpyxl.load_workbook(xlsx, data_only=False)
    grid_plans: list[dict] = []
    for sheet, county, ptype in resolve_2027_sheets(wb):
        ws = wb[sheet]
        labels: list[tuple[int, str]] = []
        sob_row = eoc_row = None
        for r in range(1, (ws.max_row or 0) + 1):
            lab = ws.cell(r, 1).value
            if not lab or not str(lab).strip():
                continue
            lab_s = norm_label(lab)
            if lab_s.startswith("summary of"):
                sob_row = r
                continue
            if lab_s.startswith("evidence of"):
                eoc_row = r
                continue
            if lab_s in {"note", "star ratings", "star rating"}:
                continue
            key = LABEL_MAP.get(lab_s)
            if not key:
                lab2 = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ?]+", "", lab_s)).strip()
                key = LABEL_MAP.get(lab2)
            if key:
                labels.append((r, key, lab_s))

        max_col = ws.max_column or 0
        for c in range(2, max_col + 1):
            header = ws.cell(1, c).value
            if header is None or not str(header).strip():
                continue
            header_s = str(header)
            pid = extract_plan_id_common(header_s)
            if not pid:
                continue
            carrier = carrier_of_2027(header_s)
            if is_healthspring_dade_broward(carrier, pid, county):
                continue
            _pid, _c, plan_name = parse_header_meta(header_s)
            plan_name = plan_name or header_s
            fields: dict = {}
            yellow_left = 0
            for r, key, lab_s in labels:
                cell = ws.cell(r, c)
                raw = cell.value
                if raw is None or (isinstance(raw, str) and not raw.strip()):
                    continue
                if is_confirmed_2027_cell(cell):
                    val = convert_value(key, raw)
                    if val is None:
                        continue
                    if key == "other" and fields.get("other"):
                        fields["other"] = f"{fields['other']}\n{val}"
                    else:
                        fields[key] = val
                elif is_yellow(cell):
                    yellow_left += 1
                    # Yellow dental procedure with a clear frequency — keep (existing helper rule)
                    if key in DENTAL_FIELD_KEYS and is_clear_dental_value(raw):
                        val = convert_value(key, raw)
                        if val is not None and key not in fields:
                            fields[key] = val
                            fields.setdefault("_dentalWorkingKeys", []).append(key)
            sob_url = eoc_url = None
            if sob_row:
                sob_cell = ws.cell(sob_row, c)
                if sob_cell.hyperlink and sob_cell.hyperlink.target:
                    sob_url = str(sob_cell.hyperlink.target).strip()
                elif isinstance(sob_cell.value, str) and sob_cell.value.strip().startswith("http"):
                    sob_url = sob_cell.value.strip()
            if eoc_row:
                eoc_cell = ws.cell(eoc_row, c)
                if eoc_cell.hyperlink and eoc_cell.hyperlink.target:
                    eoc_url = str(eoc_cell.hyperlink.target).strip()
                elif isinstance(eoc_cell.value, str) and eoc_cell.value.strip().startswith("http"):
                    eoc_url = eoc_cell.value.strip()
            grid_plans.append(
                {
                    "id": pid,
                    "planId": pid,
                    "carrier": carrier,
                    "planName": plan_name,
                    "county": county,
                    "type": ptype,
                    "fields": fields,
                    "yellowLeft": yellow_left,
                    "sobUrl": sob_url,
                    "eocUrl": eoc_url,
                    "header": header_s,
                }
            )
    return grid_plans


def build_2027_plan_objects(grid_plans: list[dict]) -> list[dict]:
    plans: list[dict] = []
    for gp in grid_plans:
        fields = dict(gp["fields"])
        dental_working = set(fields.pop("_dentalWorkingKeys", []) or [])
        confirmed_keys = [k for k in fields if k not in dental_working]
        pending = not confirmed_keys
        newp = {
            "id": gp["id"],
            "planId": gp["id"],
            "carrier": gp["carrier"],
            "planName": gp["planName"],
            "county": gp["county"],
            "type": gp["type"],
            "year": 2027,
            "tags": {
                "dental": bool(fields.get("dental")),
                "otc": bool(fields.get("otc")),
                "foodCard": False,
                "referral": str(fields.get("referral", "")).strip().lower() in ("yes", "y", "true"),
            },
            "pros": [],
            "cons": [],
            "comment": (
                "2027 SoB pending — yellow on THEI grid"
                if pending
                else "Imported from THEI 2027 plan grid (non-yellow cells)"
            ),
            "sourceQuality": "pending_sob" if pending else "grid",
            "mspLevels": fields.get("mspLevels", ""),
            "chronicConditions": fields.get("chronicConditions", ""),
            "dualLevel": {"full": False, "partial": False},
            "sobUrl": gp.get("sobUrl"),
            "eocUrl": gp.get("eocUrl"),
            "groceryCardDetail": fields.get("groceryCardDetail"),
            "yellowLeft": gp.get("yellowLeft", 0),
        }
        for k, v in fields.items():
            newp[k] = prefer_store(k, v, None)
        if newp.get("referral") is not None:
            newp["tags"]["referral"] = str(newp["referral"]).strip().lower() in ("yes", "y", "true")
        plans.append(newp)

    # Sibling fill for junk dental only — curated 2026 overlay must not overwrite clear 2027 values
    sibling_filled = apply_sibling_dental_on_plan_objects(plans)
    curated = apply_curated_on_plan_objects(plans)
    print(f"2027 dental sibling-fill={sibling_filled} curated={curated}")
    return plans


def archive_2026_plans(plans: list[dict]) -> list[dict]:
    archived = []
    for p in plans:
        q = dict(p)
        q.setdefault("year", 2026)
        archived.append(q)
    ARCHIVE_2026_PATH.parent.mkdir(parents=True, exist_ok=True)
    ARCHIVE_2026_PATH.write_text(
        json.dumps(archived, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"archived 2026 plan-data → {ARCHIVE_2026_PATH} ({len(archived)} plans)")
    return archived


# Verified SoB links that the workbook hyperlinks get wrong (MAX.md 2026-10-03):
# H4140-023 DrSelect-SFL uses the DrSelect PDF; H4140-022 stays on Dr Max.
SOB_URL_OVERRIDES_2027 = {
    "H4140-023": "https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrSelect_ENG.pdf",
    "H4140-022": "https://www.doctorshcp.com/wp-content/uploads/2027_SOB_SF_DrMax_ENG.pdf",
}


def apply_sob_overrides_2027(plans: list) -> int:
    fixed = 0
    for plan in plans:
        pid = str(plan.get("planId") or plan.get("id") or "")[:9].upper()
        url = SOB_URL_OVERRIDES_2027.get(pid)
        if url and plan.get("sobUrl") != url:
            plan["sobUrl"] = url
            fixed += 1
    return fixed


def sync_2027(xlsx: Path) -> int:
    if not xlsx.exists():
        print(f"missing {xlsx}", file=sys.stderr)
        return 1
    text = HTML_PATH.read_text(encoding="utf-8")
    m, current = read_plan_data_block(text, "plan-data")
    if not m:
        print("plan-data block not found", file=sys.stderr)
        return 1

    existing_2026_m, existing_2026 = read_plan_data_block(text, "plan-data-2026")
    if existing_2026 is None:
        # Current live block is still 2026 unless it already has year=2027
        looks_2027 = bool(current) and all(p.get("year") == 2027 for p in current[:3])
        if not looks_2027:
            existing_2026 = archive_2026_plans(current)
        elif ARCHIVE_2026_PATH.exists():
            existing_2026 = json.loads(ARCHIVE_2026_PATH.read_text(encoding="utf-8"))
        else:
            existing_2026 = []
    elif not ARCHIVE_2026_PATH.exists():
        archive_2026_plans(existing_2026)

    grid_plans = parse_grid_2027(xlsx)
    plans = build_2027_plan_objects(grid_plans)
    print(
        f"2027 grid columns: {len(grid_plans)}; plan-data objects: {len(plans)} "
        f"(sheet {SHEET_ID_2027})"
    )
    by_carrier = defaultdict(int)
    pending = 0
    hs = 0
    for p in plans:
        by_carrier[p.get("carrier", "?")] += 1
        if p.get("sourceQuality") == "pending_sob":
            pending += 1
        if is_healthspring_dade_broward(p.get("carrier", ""), p.get("id"), p.get("county", "")):
            hs += 1
    print("by carrier", dict(sorted(by_carrier.items())))
    print(f"pending_sob stubs={pending} healthspring_in_output={hs}")

    print(f"sob url overrides applied: {apply_sob_overrides_2027(plans)}")
    text = replace_or_insert_script_json(text, "plan-data", plans)
    if existing_2026:
        text = replace_or_insert_script_json(text, "plan-data-2026", existing_2026, after_id="plan-data")
    HTML_PATH.write_text(text, encoding="utf-8")
    print(f"wrote {HTML_PATH} ({HTML_PATH.stat().st_size} bytes) year=2027")
    return 0 if hs == 0 else 2


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--year", type=int, default=2026, choices=(2026, 2027))
    parser.add_argument("--xlsx", type=Path, default=None)
    args = parser.parse_args()
    if args.year == 2027:
        return sync_2027(args.xlsx or XLSX_2027_PATH)

    xlsx = args.xlsx or XLSX_PATH
    text = HTML_PATH.read_text(encoding="utf-8")
    m, plans = read_plan_data_block(text, "plan-data")
    if not m:
        print("plan-data block not found", file=sys.stderr)
        return 1
    grid_plans = parse_grid(xlsx)
    print(f"grid plans: {len(grid_plans)}; max plans before: {len(plans)}")

    by_token = rebuild_token_index(plans)

    null_zero_before = 0
    for gp in grid_plans:
        matches = find_matches(plans, gp, by_token)
        if not matches:
            continue
        mp = matches[0]
        for k, v in gp["fields"].items():
            if isinstance(v, (int, float)) and float(v) == 0 and (mp.get(k) in (None, "")):
                null_zero_before += 1
    print(f"null-vs-zero before: {null_zero_before}")

    updated_plans = 0
    field_updates = 0
    created = 0
    canonicalized = 0

    for gp in grid_plans:
        matches = find_matches(plans, gp, by_token)
        if matches:
            mp = matches[0]
            changed = False
            # canonicalize id/planId toward grid CMS id when current is slug
            cur_pid = str(mp.get("planId") or mp.get("id") or "")
            if not re.match(r"^[HR]\d{3,4}-", cur_pid) and re.match(r"^[HR]\d{3,4}-", gp["id"]):
                mp["planId"] = gp["id"]
                mp["id"] = gp["id"]
                canonicalized += 1
                changed = True
            elif re.match(r"^[HR]\d{3,4}-", gp["id"]) and compact_id(cur_pid) != compact_id(gp["id"]):
                # keep Max's more specific id (e.g. H1036-054C) if it extends grid
                if compact_id(gp["id"]) not in compact_id(cur_pid) and compact_id(cur_pid) not in id_tokens(gp["id"]):
                    pass
            for k, v in gp["fields"].items():
                cur = mp.get(k)
                newv = prefer_store(k, v, cur)
                # Don't clobber a clear dental procedure cell with "$0 varies" junk
                if k in DENTAL_FIELD_KEYS and is_junk_dental_value(newv) and is_clear_dental_value(cur):
                    continue
                # Grid is source of truth — always write grid value when present
                if not values_equal(cur, newv):
                    mp[k] = newv
                    field_updates += 1
                    changed = True
            if mp.get("referral") is not None:
                mp.setdefault("tags", {})
                if isinstance(mp["tags"], dict):
                    mp["tags"]["referral"] = str(mp["referral"]).strip().lower() in (
                        "yes",
                        "y",
                        "true",
                    )
            if changed:
                updated_plans += 1
        else:
            newp = {
                "id": gp["id"],
                "planId": gp["id"],
                "carrier": gp["carrier"],
                "planName": gp["planName"],
                "county": gp["county"],
                "type": gp["type"],
                "tags": {
                    "dental": True,
                    "otc": True,
                    "foodCard": False,
                    "referral": str(gp["fields"].get("referral", "")).strip().lower()
                    in ("yes", "y", "true"),
                },
                "pros": [],
                "cons": [],
                "comment": "Imported from THEI 2026 plan grid",
                "sourceQuality": "grid",
                "mspLevels": gp["fields"].get("mspLevels", ""),
                "chronicConditions": gp["fields"].get("chronicConditions", ""),
                "dualLevel": {"full": False, "partial": False},
                "sobUrl": None,
                "groceryCardDetail": None,
            }
            newp.update(gp["fields"])
            plans.append(newp)
            created += 1
            by_token = rebuild_token_index(plans)

    sibling_filled = apply_sibling_dental_on_plan_objects(plans)
    curated = apply_curated_on_plan_objects(plans)
    print(f"dental sibling-fill={sibling_filled} curated={curated}")

    # Validate
    by_token = rebuild_token_index(plans)
    null_zero_after = 0
    mismatches = []
    unmatched = []
    for gp in grid_plans:
        matches = find_matches(plans, gp, by_token)
        if not matches:
            unmatched.append((gp["id"], gp["county"], gp["planName"][:50]))
            continue
        mp = matches[0]
        for k, v in gp["fields"].items():
            if isinstance(v, (int, float)) and float(v) == 0 and (mp.get(k) in (None, "")):
                null_zero_after += 1
            stored = prefer_store(k, v, mp.get(k))
            if not values_equal(mp.get(k), stored) and not values_equal(mp.get(k), v):
                mismatches.append((gp["id"], gp["county"], k, v, mp.get(k)))

    print(
        f"updated_plans={updated_plans} field_updates={field_updates} "
        f"created={created} canonicalized={canonicalized} total={len(plans)}"
    )
    print(f"null-vs-zero after: {null_zero_after}")
    print(f"mismatches remaining: {len(mismatches)}")
    for row in mismatches[:20]:
        print("  mismatch", row)
    print(f"unmatched: {len(unmatched)}")
    for row in unmatched:
        print("  unmatched", row)

    for pid in ("H4140-001", "H5420-001"):
        for p in plans:
            if p.get("county") == "Miami-Dade" and pid in str(p.get("id", "")):
                focus = {
                    k: p.get(k)
                    for k in (
                        "premium",
                        "pcpCopay",
                        "specialistCopay",
                        "tier1",
                        "tier2",
                        "tier3",
                        "tier4",
                        "tier5",
                        "rxDeductible",
                        "otc",
                        "partBGiveback",
                    )
                }
                print("FOCUS", p.get("id"), p.get("planName"), focus)

    new_json = json.dumps(plans, ensure_ascii=False, separators=(",", ":"))
    HTML_PATH.write_text(text[: m.start(1)] + new_json + text[m.end(1) :], encoding="utf-8")
    print(f"wrote {HTML_PATH} ({HTML_PATH.stat().st_size} bytes)")

    if null_zero_after > 0 or unmatched:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
