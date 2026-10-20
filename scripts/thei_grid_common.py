"""Shared THEI grid helpers for 2026 merge-sync and 2027 green/non-yellow sync.

The Oct 2026 working 2027 sheet cleared classic light-green fills. Confirmed /
working 2027 dollars are typically white/uncolored. Yellow (FFF2CC / FFFF00 /
FFEB3B) still means leftover unconfirmed — never promote those as 2027 facts.
Classic green fills still count as confirmed if they reappear.
"""

from __future__ import annotations

import re
from pathlib import Path

from dental_procedure_rows import is_clear_dental_value, is_dental_procedure_label

# Native Google Sheet (converted from the uploaded xlsx 1BYhBfOzdeJOMEVXIKJkHrZzEohrOBR-N on 2026-10-09).
# A native Sheet has no raw bytes: download it as a Drive export to .xlsx (Drive connector
# DownloadFile, or File > Download > .xlsx). The sheet is not link-public, so an anonymous
# `curl .../export?format=xlsx` returns a 401 login page, not a workbook.
SHEET_ID_2027 = "1Vz9XBPwTO3a7181otdTf_NFkZFCXK4OT8O05ooeB0xg"
SHEET_GID_2027 = "992380461"
SHEET_ID_2027_PREVIOUS_XLSX = "1BYhBfOzdeJOMEVXIKJkHrZzEohrOBR-N"


def require_xlsx(path: Path) -> None:
    """Fail clearly when the download is not a real .xlsx (e.g. a Google login page)."""
    p = Path(path)
    if not p.exists():
        raise SystemExit(f"missing {p}: export the 2027 grid (sheet {SHEET_ID_2027}) to .xlsx first")
    with p.open("rb") as fh:
        magic = fh.read(4)
    if magic != b"PK\x03\x04":
        raise SystemExit(
            f"{p} is not an .xlsx (got {magic!r}); the anonymous export URL returns a login page. "
            f"Download sheet {SHEET_ID_2027} as .xlsx through Drive (signed in) instead."
        )

# Legacy combined DSNP tabs (older workbook) plus the Oct 2026 Full/Partial split.
SHEET_SPECS_2027 = [
    ("DADE- HMO", "Miami-Dade", "HMO"),
    ("BWD- HMO", "Broward", "HMO"),
    ("DADE-CSNP", "Miami-Dade", "C-SNP"),
    ("BWD-CSNP", "Broward", "C-SNP"),
    ("Dade- DSNP Full", "Miami-Dade", "D-SNP"),
    ("Dade- DSNP Partial", "Miami-Dade", "D-SNP"),
    ("BWD-DSNP Full", "Broward", "D-SNP"),
    ("BWD-DSNP Partial", "Broward", "D-SNP"),
    ("Dade- DSNP", "Miami-Dade", "D-SNP"),
    ("BWD-DSNP", "Broward", "D-SNP"),
    ("DADE- Giveback", "Miami-Dade", "HMO"),
    ("BWD-Giveback", "Broward", "HMO"),
    ("DADE-PPO", "Miami-Dade", "PPO"),
    ("BWD-PPO", "Broward", "PPO"),
]

LEGACY_DSNP = {
    ("Dade- DSNP", "Miami-Dade"),
    ("BWD-DSNP", "Broward"),
}

SPLIT_DSNP = {
    ("Dade- DSNP Full", "Miami-Dade"),
    ("Dade- DSNP Partial", "Miami-Dade"),
    ("BWD-DSNP Full", "Broward"),
    ("BWD-DSNP Partial", "Broward"),
}

YELLOW_RGB_SUFFIXES = ("FFF2CC", "FFFF00", "FFEB3B")
GREEN_RGB_SUFFIXES = (
    "E8F5E9",
    "C8E6C9",
    "C6EFCE",
    "D9EAD3",
)

CARRIER_ALIASES = [
    ("UHC", "UHC"),
    ("United", "UHC"),
    ("Preferred", "UHC"),
    ("AARP", "UHC"),
    ("MedicareMax", "UHC"),
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
    ("Doctors", "Doctors"),
    ("Doctor", "Doctors"),
    ("Florida Blue", "Florida Blue"),
    ("FL Blue", "Florida Blue"),
    ("HealthSpring", "HealthSpring"),
    ("Cigna", "HealthSpring"),
    ("Solis", "Solis"),
    ("Gold Kidney", "Gold Kidney"),
]


def fill_rgb(cell) -> str | None:
    fill = getattr(cell, "fill", None)
    if not fill or fill.fill_type is None:
        return None
    fg = fill.fgColor
    if fg is None or fg.type != "rgb" or not fg.rgb:
        return None
    return str(fg.rgb).upper()


def is_green(cell) -> bool:
    rgb = fill_rgb(cell)
    return bool(rgb and any(rgb.endswith(s) for s in GREEN_RGB_SUFFIXES))


def is_yellow(cell) -> bool:
    rgb = fill_rgb(cell)
    return bool(rgb and any(rgb.endswith(s) for s in YELLOW_RGB_SUFFIXES))


def is_confirmed_2027_cell(cell) -> bool:
    """True when the cell is a 2027 working/confirmed value (not yellow leftover)."""
    if cell is None:
        return False
    val = cell.value
    if val is None or (isinstance(val, str) and not val.strip()):
        return False
    if is_yellow(cell):
        return False
    return True


def resolve_2027_sheets(workbook) -> list[tuple[str, str, str]]:
    names = set(workbook.sheetnames)
    has_split = any(sheet in names for sheet, _ in SPLIT_DSNP)
    out: list[tuple[str, str, str]] = []
    for sheet, county, ptype in SHEET_SPECS_2027:
        if sheet not in names:
            continue
        if has_split and (sheet, county) in LEGACY_DSNP:
            continue
        out.append((sheet, county, ptype))
    return out


_HYPERLINK_FORMULA = re.compile(r'^\s*=\s*HYPERLINK\(\s*"([^"]+)"', re.I)


def formula_link(value) -> str | None:
    """URL inside an =HYPERLINK("url", ...) formula string."""
    if isinstance(value, str):
        m = _HYPERLINK_FORMULA.match(value)
        if m and m.group(1).strip().lower().startswith("http"):
            return m.group(1).strip()
    return None


def cell_link(cell) -> str | None:
    """URL behind a grid doc cell.

    The native Google Sheet export carries links three ways: a cell hyperlink,
    an =HYPERLINK("url","label") formula (Gold Kidney Oct docs), or a bare URL.
    """
    if cell is None:
        return None
    link = getattr(cell, "hyperlink", None)
    if link is not None and getattr(link, "target", None):
        return str(link.target).strip()
    val = getattr(cell, "value", None)
    if isinstance(val, str):
        if formula_link(val):
            return formula_link(val)
        if val.strip().startswith("http"):
            return val.strip()
    return None


_HYPERLINK_LABEL = re.compile(r'^\s*=\s*HYPERLINK\(\s*"[^"]*"\s*[,;]\s*"([^"]*)"', re.I)


def cell_caption(value):
    """Visible text of a cell; =HYPERLINK("url","label") shows its label."""
    if isinstance(value, str):
        m = _HYPERLINK_LABEL.match(value)
        if m:
            return m.group(1)
    return value


def _glued_plan_id(s: str) -> str | None:
    """'...HMO-POS-DSNPH1045-063' — id glued to a word, so \\b never matches."""
    m = re.search(r"(?<![0-9])([HR]\d{4})\s*-\s*(\d{3}[A-Z]?)(?![0-9])", s)
    if not m:
        return None
    return f"{m.group(1).upper()}-{m.group(2)}"


def extract_plan_id(header: object) -> str | None:
    pid = _extract_plan_id(header)
    if pid or not header:
        return pid
    return _glued_plan_id(str(header).replace("‑", "-").replace("–", "-"))


def _extract_plan_id(header: object) -> str | None:
    if not header:
        return None
    s = str(header).replace("‑", "-").replace("–", "-")
    m = re.search(r"\b([HR]\d{3,4})\s*\|\s*(\d{2,4})\b", s, re.I)
    if m:
        return f"{m.group(1).upper()}-{m.group(2)}"
    m = re.search(
        r"\b([HR]\d{3,4})\s*-\s*(\d{2,4}[A-Z]?)(?:\s*(?:FL-?)(\d{2,4})|\s*-\s*(\d{1,4})|\s*/\s*-?\s*(\d{2,4}))?",
        s,
        re.I,
    )
    if not m:
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
    if m.group(3):
        return f"{base}-FL-{m.group(3)}"
    if m.group(4):
        return f"{base}-{m.group(4)}"
    if m.group(5):
        return f"{base}/{m.group(5)}"
    return base


def carrier_of(header: str) -> str:
    for key, nice in CARRIER_ALIASES:
        if re.search(rf"\b{re.escape(key)}\b", header, re.I) or header.startswith(key):
            return nice
    return header.split()[0] if header.split() else "Unknown"


def is_healthspring_dade_broward(carrier: str, plan_id: str | None, county: str) -> bool:
    if county not in ("Miami-Dade", "Broward"):
        return False
    if carrier == "HealthSpring":
        return True
    return bool(plan_id and str(plan_id).upper().startswith("H5410-"))


def skip_yellow_dental(lab: str, val: str) -> bool:
    """Yellow dental procedure rows stay only when the value is a clear frequency / Yes-No."""
    return is_dental_procedure_label(lab) and is_clear_dental_value(val)


def default_2027_xlsx() -> Path:
    return Path("/tmp/thei-2027-grid.xlsx")


# ─── Plan marketing names ────────────────────────────────────────────────────
# Grid headers carry working tags that are not part of the plan name: "**NEW 2027**", "(NEW 2027)",
# "- NEW 2027", bare "**NEW**", stray "**" bold markers. Same rules as artifacts/plan-name.js (the UI and
# server run that one on every render). Only the tag and markers go: "NON-COMMISSIONABLE" (R0759-001),
# contract-PBP IDs, "(HMO D-SNP)", "FL-0031" all stay as written.
_SEP = r"[\s\-\u2010-\u2015:|\u00b7]*"
_NEW_YEAR_TAG_RE = re.compile(_SEP + r"[(\[]?\s*\**\s*\bnew\s*(?:for\s+)?2027\b\s*\**\s*[)\]]?", re.I)
_BARE_NEW_TAG_RE = re.compile(_SEP + r"(?:\*+\s*NEW\b\s*\**|\(\s*\**\s*NEW\s*\**\s*\))", re.I)
_TRAILING_NEW_RE = re.compile(r"[\s\-\u2010-\u2015:|\u00b7]+NEW\s*$")


def clean_plan_marketing_name(name: object) -> str:
    """'Humana Choice Giveback **NEW 2027' → 'Humana Choice Giveback'."""
    if name is None:
        return ""
    s = re.sub(r"\s+", " ", str(name))
    s = _NEW_YEAR_TAG_RE.sub(" ", s)
    s = _BARE_NEW_TAG_RE.sub(" ", s)
    s = _TRAILING_NEW_RE.sub(" ", s)
    s = re.sub(r"\*{2,}", " ", s)
    s = re.sub(r"^\s*\*+|\*+\s*$", " ", s)
    s = re.sub(r"\(\s*\)|\[\s*\]", " ", s)
    s = re.sub(r"\s+([-\u2010-\u2015])\s+(?:[-\u2010-\u2015]\s+)+", r" \1 ", s)
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"^[\s\-\u2010-\u2015:|\u00b7,]+|[\s\-\u2010-\u2015:|\u00b7,]+$", "", s)
    return s.strip()
