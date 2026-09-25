"""Shared helpers for THEI dental procedure rows (Crowns, Bridges, …).

Used by the 2027 KB export and the 2026 plan-data sync so those sub-rows
are not dropped, and so a vague county cell ("$0 varies") can borrow the
clearer sibling-county value for the same CMS ID.
"""

from __future__ import annotations

import re

DENTAL_PROCEDURE_LABELS = {
    "deep cleaning",
    "dentures",
    "fillings",
    "root canals",
    "extractions",
    "crowns",
    "bridges",
    "implants",
    "dental implants",
}

DENTAL_FIELD_KEYS = {
    "dentalDeepCleaning",
    "dentalDentures",
    "dentalFillings",
    "dentalRootCanals",
    "dentalExtractions",
    "dentalCrowns",
    "dentalBridges",
    "dentalImplants",
}

# THEI-verified overlay: CareComplete H1019-150 is statewide (same SoB).
# DADE-CSNP Crowns/Bridges are "2 every 5 years" / "Yes". BWD-CSNP still
# has leftover "$0 varies" junk on the working sheet.
CURATED_DENTAL_PROCEDURES: dict[tuple[str, str], list[tuple[str, str]]] = {
    ("H1019-150", "Miami-Dade"): [
        ("Crowns", "2 every 5 years"),
        ("Bridges", "Yes"),
    ],
    ("H1019-150", "Broward"): [
        ("Crowns", "2 every 5 years"),
        ("Bridges", "Yes"),
    ],
}

_JUNK_RE = re.compile(
    r"^(?:"
    r"\$0\s*varies|"
    r"varies|"
    r"not listed|"
    r"n/?a|"
    r"none|"
    r"—|"
    r"-|"
    r"\*"
    r")$",
    re.I,
)


def norm_label(s: object) -> str:
    if s is None:
        return ""
    return re.sub(r"\s+", " ", str(s).replace("\n", " ")).strip().lower()


def is_dental_procedure_label(lab: object) -> bool:
    return norm_label(lab) in DENTAL_PROCEDURE_LABELS


def collapse_val(val: object) -> str:
    if val is None:
        return ""
    if isinstance(val, float) and val == int(val):
        return str(int(val))
    return re.sub(r"\s+", " ", str(val).replace("\n", " ")).strip()


def is_junk_dental_value(val: object) -> bool:
    s = collapse_val(val)
    if not s or s in {'"', "“", "”"}:
        return True
    if _JUNK_RE.match(s):
        return True
    # Bare 0 on a procedure row is ambiguous ($0 copay vs not covered vs empty)
    if s in {"0", "0.0"}:
        return True
    return False


def is_clear_dental_value(val: object) -> bool:
    return not is_junk_dental_value(val)


def field_map_has_label(fields: list[tuple[str, str]], lab: str) -> bool:
    want = norm_label(lab)
    return any(norm_label(existing) == want for existing, _ in fields)


def merge_dental_row(fields: list[tuple[str, str]], lab: str, val: str) -> bool:
    """Insert or replace a dental procedure row. Returns True if changed."""
    want = norm_label(lab)
    for i, (existing, cur) in enumerate(fields):
        if norm_label(existing) == want:
            if collapse_val(cur) == collapse_val(val):
                return False
            if is_clear_dental_value(cur) and is_junk_dental_value(val):
                return False
            fields[i] = (existing, val)
            return True
    fields.append((lab, val))
    return True


def apply_curated_dental(plan_id: str, county: str, fields: list[tuple[str, str]]) -> list[str]:
    notes: list[str] = []
    for lab, val in CURATED_DENTAL_PROCEDURES.get((plan_id, county), []):
        if merge_dental_row(fields, lab, val):
            notes.append(f"{lab}: THEI grid overlay ({val})")
    return notes


def apply_sibling_dental_fill(plans: list[dict], fields_key: str = "fields") -> int:
    """Copy clear dental procedure values onto sibling-county rows of the same CMS ID."""
    by_id: dict[str, list[dict]] = {}
    for p in plans:
        by_id.setdefault(str(p.get("id") or ""), []).append(p)

    filled = 0
    for group in by_id.values():
        if len(group) < 2:
            continue
        donors: dict[str, tuple[dict, str, str]] = {}
        for p in group:
            for lab, val in p.get(fields_key) or []:
                if not is_dental_procedure_label(lab) or not is_clear_dental_value(val):
                    continue
                donors.setdefault(norm_label(lab), (p, lab, val))
        for p in group:
            fields = p.setdefault(fields_key, [])
            have = {norm_label(lab) for lab, _ in fields if is_clear_dental_value(_)}
            for lab_l, (donor, lab, val) in donors.items():
                if donor is p or lab_l in have:
                    continue
                merge_dental_row(fields, lab, val)
                p.setdefault("dentalSiblingNotes", []).append(
                    f"{lab}: used {donor.get('county')} THEI grid ({val}); "
                    f"{p.get('county')} cell was vague or blank"
                )
                filled += 1
    return filled


def apply_sibling_dental_on_plan_objects(plans: list[dict]) -> int:
    """Same sibling fill, but for live #plan-data objects (dentalCrowns keys)."""
    label_to_key = {
        "deep cleaning": "dentalDeepCleaning",
        "dentures": "dentalDentures",
        "fillings": "dentalFillings",
        "root canals": "dentalRootCanals",
        "extractions": "dentalExtractions",
        "crowns": "dentalCrowns",
        "bridges": "dentalBridges",
        "implants": "dentalImplants",
        "dental implants": "dentalImplants",
    }
    key_to_label = {v: k.title() if k != "deep cleaning" else "Deep Cleaning" for k, v in label_to_key.items()}
    key_to_label["dentalCrowns"] = "Crowns"
    key_to_label["dentalBridges"] = "Bridges"
    key_to_label["dentalImplants"] = "Implants"

    by_id: dict[str, list[dict]] = {}
    for p in plans:
        pid = str(p.get("planId") or p.get("id") or "")
        if pid:
            by_id.setdefault(pid, []).append(p)

    filled = 0
    for group in by_id.values():
        if len(group) < 2:
            continue
        for key in DENTAL_FIELD_KEYS:
            donors = [
                p
                for p in group
                if key in p and is_clear_dental_value(p.get(key))
            ]
            if not donors:
                continue
            for p in group:
                if is_clear_dental_value(p.get(key)):
                    continue
                donor = next((d for d in donors if d is not p), None)
                if not donor:
                    continue
                p[key] = collapse_val(donor.get(key)) if isinstance(donor.get(key), str) else donor.get(key)
                if isinstance(p.get(key), str):
                    p[key] = collapse_val(p[key])
                filled += 1
    return filled


def apply_curated_on_plan_objects(plans: list[dict]) -> int:
    label_to_key = {
        "crowns": "dentalCrowns",
        "bridges": "dentalBridges",
    }
    n = 0
    for p in plans:
        pid = str(p.get("planId") or p.get("id") or "")
        county = str(p.get("county") or "")
        for lab, val in CURATED_DENTAL_PROCEDURES.get((pid, county), []):
            key = label_to_key.get(norm_label(lab))
            if not key:
                continue
            if collapse_val(p.get(key)) != val:
                p[key] = val
                n += 1
    return n
