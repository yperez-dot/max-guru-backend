#!/usr/bin/env python3
"""Refresh Max SEP KB from the live Agent Medicare Hub tracker app.

Source of truth is pages/sep-tracker-app.html (embedded `var DATA=[...]`),
which is what https://www.agentmedicarehub.com/sep-tracker/ iframes —
NOT the older sep-tracker/data/seps.json snapshot.
"""

from __future__ import annotations

import json
import re
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

OUT = Path("/workspace/max-knowledge/hub")
STATE_DIR = OUT / "seps-by-state"
UA = "Mozilla/5.0 (compatible; THEI-Max-SEP-refresh/1.0)"

SOURCES = [
    "https://www.agentmedicarehub.com/sep-tracker-app.html?v=20260824",
    "https://raw.githubusercontent.com/yperez-dot/agent-medicare-hub/main/pages/sep-tracker-app.html",
]


def fetch_html() -> tuple[str, str]:
    last_err = ""
    for url in SOURCES:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.read().decode("utf-8", "replace"), url
        except Exception as e:
            last_err = f"{url}: {e}"
    raise SystemExit(f"Failed to fetch SEP tracker app: {last_err}")


def extract_data(html: str) -> list[dict]:
    m = re.search(r"var DATA=(\[.*?\]);\s*\n", html, re.S)
    if not m:
        m = re.search(r"var DATA=(\[[\s\S]*?\]);", html)
    if not m:
        raise SystemExit("Could not find var DATA=[...] in tracker HTML")
    return json.loads(m.group(1))


def parse_mdy(token: str) -> str | None:
    token = (token or "").strip().replace("\u2013", "-").replace("\u2014", "-")
    if not token or re.search(r"year-?round|ongoing|n/?a", token, re.I):
        return None
    for fmt in ("%b %d, %Y", "%B %d, %Y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(token, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def split_window(window: str) -> tuple[str | None, str | None]:
    if not window:
        return None, None
    w = window.replace("\u2013", "–").replace("\u2014", "–")
    if re.search(r"year-?round", w, re.I):
        # e.g. "Jan 1, 2025 – Year-round"
        left = re.split(r"\s*[–-]\s*", w, maxsplit=1)[0].strip()
        return parse_mdy(left), None
    parts = re.split(r"\s*[–-]\s*", w, maxsplit=1)
    if len(parts) == 1:
        return parse_mdy(parts[0]), None
    return parse_mdy(parts[0]), parse_mdy(parts[1])


def counties_list(raw) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    s = str(raw).strip()
    if not s:
        return []
    if s.upper() in {"ALL", "ALL COUNTIES", "STATEWIDE"}:
        return ["STATEWIDE"]
    # split on commas / "and"
    parts = re.split(r",|\band\b", s, flags=re.I)
    out = []
    for p in parts:
        p = re.sub(r"\s+", " ", p).strip(" \n\t.;")
        p = re.sub(r"\s+counties$", "", p, flags=re.I).strip()
        if p:
            out.append(p)
    return out


def normalize_status(s: str) -> str:
    s = (s or "").strip().lower()
    if s in {"active", "ended", "expiring", "yearround"}:
        return s
    if "end" in s:
        return "ended"
    if "expir" in s:
        return "expiring"
    if "year" in s:
        return "yearround"
    return s or "active"


def convert_item(raw: dict, today: date) -> dict:
    sep_eff, sep_term = split_window(raw.get("sepWindow") or "")
    # Prefer explicit sepEnd when present
    if raw.get("sepEnd"):
        sep_term = str(raw["sepEnd"])[:10]
    inc_eff, inc_term = split_window(raw.get("incidentWindow") or "")
    status = normalize_status(raw.get("status"))
    days_until = days_since = None
    if sep_term:
        try:
            end = date.fromisoformat(sep_term)
            delta = (end - today).days
            if delta >= 0:
                days_until = delta
            else:
                days_since = abs(delta)
        except ValueError:
            pass
    counties_raw = raw.get("counties")
    decls = raw.get("declarations") or []
    decl_num = ", ".join(str(x) for x in decls) if isinstance(decls, list) else str(decls or "")
    return {
        "id": raw.get("id"),
        "raw_status": raw.get("status"),
        "status": status,
        "entity": "Hub tracker",
        "state": raw.get("state"),
        "state_raw": raw.get("state"),
        "lookback": None,
        "declaration_name": (raw.get("name") or "").replace("\n\n", " — "),
        "declaration_number": decl_num or None,
        "disaster_type_raw": raw.get("type"),
        "disaster_types": [t.strip() for t in re.split(r"[;\n]+", str(raw.get("type") or "")) if t.strip()],
        "declaration_type": None,
        "counties": counties_list(counties_raw),
        "counties_raw": counties_raw if isinstance(counties_raw, str) else ", ".join(counties_list(counties_raw)),
        "declaration_date": None,
        "incident_effective": inc_eff,
        "incident_termination": inc_term,
        "sep_effective": sep_eff,
        "sep_termination": sep_term,
        "days_until_expiry": days_until,
        "days_since_expiry": days_since,
        "sep_window_raw": raw.get("sepWindow"),
        "incident_window_raw": raw.get("incidentWindow"),
        "sort_rank": raw.get("sortRank"),
    }


def write_markdown(seps: dict) -> None:
    items = seps["items"]
    lines = [
        "# SEP Tracker Reference (Agent Medicare Hub)",
        "",
        f"Snapshot: generated_at={seps.get('generated_at')} "
        f"last_imported={seps.get('last_imported')} last_updated={seps.get('last_updated')}",
        f"Counts: {json.dumps(seps.get('counts'))}",
        f"Source: {seps.get('source')}",
        f"Live UI: {seps.get('live_url')}",
        "",
        "Use for Special Enrollment Period questions. Cite SEP id/name, counties, and windows.",
        "Prefer state files under hub/seps-by-state/XX for focused answers.",
        "For the interactive tracker, agents can open Agent Medicare Hub → SEP Tracker.",
        "",
    ]
    # Active / expiring first, then yearround, then ended
    order = {"active": 0, "expiring": 1, "yearround": 2, "ended": 3}
    for it in sorted(items, key=lambda x: (order.get(x.get("status"), 9), x.get("state") or "", x.get("id") or "")):
        header = " — ".join(
            x for x in [str(it.get("id") or "").strip(), str(it.get("declaration_name") or "").strip()] if x
        )
        lines.append(f"## {header or 'SEP entry'}")
        for k, v in it.items():
            if v is None or v == "":
                continue
            if isinstance(v, (dict, list)):
                v = json.dumps(v, ensure_ascii=False)
            lines.append(f"- **{k}**: {v}")
        lines.append("")
    (OUT / "sep-tracker.md").write_text("\n".join(lines), encoding="utf-8")


def write_by_state(seps: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    # clear old state files
    for p in STATE_DIR.glob("*.md"):
        p.unlink()
    by: dict[str, list] = defaultdict(list)
    for it in seps["items"]:
        st = (it.get("state") or "XX").upper()
        by[st].append(it)
    order = {"active": 0, "expiring": 1, "yearround": 2, "ended": 3}
    for st, items in sorted(by.items()):
        items = sorted(items, key=lambda x: (order.get(x.get("status"), 9), x.get("id") or ""))
        lines = [
            f"# SEP Tracker — {st}",
            "",
            f"{len(items)} entries from Agent Medicare Hub SEP snapshot "
            f"({seps.get('last_updated')}).",
            f"Source: {seps.get('source')}",
            "",
        ]
        for it in items:
            lines.append(f"## {it.get('id')} — {it.get('declaration_name')}")
            for k in [
                "status",
                "raw_status",
                "entity",
                "declaration_name",
                "disaster_types",
                "disaster_type_raw",
                "counties",
                "counties_raw",
                "sep_effective",
                "sep_termination",
                "sep_window_raw",
                "incident_effective",
                "incident_termination",
                "incident_window_raw",
                "days_until_expiry",
                "declaration_number",
                "lookback",
                "declaration_type",
            ]:
                v = it.get(k)
                if v is None or v == "":
                    continue
                if isinstance(v, (dict, list)):
                    v = json.dumps(v, ensure_ascii=False)
                lines.append(f"- **{k}**: {v}")
            lines.append("")
        (STATE_DIR / f"{st}.md").write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    today = date.today()
    html, src_url = fetch_html()
    raw_items = extract_data(html)
    items = [convert_item(r, today) for r in raw_items]
    counts = {
        "total": len(items),
        "active": sum(1 for i in items if i["status"] == "active"),
        "expiring": sum(1 for i in items if i["status"] == "expiring"),
        "ended": sum(1 for i in items if i["status"] == "ended"),
        "yearround": sum(1 for i in items if i["status"] == "yearround"),
        "fl_active": sum(
            1 for i in items if i.get("state") == "FL" and i["status"] in ("active", "expiring")
        ),
    }
    seps = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "today": today.isoformat(),
        "last_imported": today.isoformat(),
        "last_updated": today.isoformat(),
        "source": "Agent Medicare Hub live sep-tracker-app.html (Aug 2026 refresh incl. FEMA xl entries)",
        "source_url": src_url,
        "live_url": "https://www.agentmedicarehub.com/sep-tracker",
        "counts": counts,
        "items": items,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "seps.json").write_text(json.dumps(seps, indent=2), encoding="utf-8")
    write_markdown(seps)
    write_by_state(seps)
    print("counts", counts)
    print("FL active/expiring:")
    for i in items:
        if i.get("state") == "FL" and i["status"] in ("active", "expiring"):
            print(" ", i["id"], i["sep_termination"], i["declaration_name"][:70])
    print("wrote seps.json + sep-tracker.md +", len(list(STATE_DIR.glob('*.md'))), "state files")


if __name__ == "__main__":
    main()
