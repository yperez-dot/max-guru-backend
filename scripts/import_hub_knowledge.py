#!/usr/bin/env python3
"""Import Agent Medicare Hub pages + SEP tracker into max-knowledge/hub for Max tools."""

from __future__ import annotations

import html
import json
import re
from pathlib import Path

HUB_PAGES = Path("/tmp/amh/pages")
SEP_JSON = Path("/tmp/amh/sep-tracker/data/seps.json")
OUT = Path("/workspace/max-knowledge/hub")

INCLUDE = [
    "compliance.html",
    "medicare-basics.html",
    "medicaid-lis.html",
    "certs.html",
    "certs-compliance.html",
    "getting-started.html",
    "hra-guide.html",
    "non-comm-plans.html",
    "carrier-contact-guide.html",
    "retention-toolkit.html",
    "aep-2027-training.html",
    "ma-pdp-certs.html",
    "medicare-supplements.html",
    "agentsync-guide.html",
    "nextere-guide.html",
    "ahip-success.html",
    "client-forms.html",
    "lead-gen-library.html",
    "sales-library.html",
    "retention-library.html",
    "contracting-blackout.html",
    "agent-benefits.html",
    "chronic-conditions.html",
]


def html_to_text(raw: str) -> str:
    t = re.sub(r"<script[\s\S]*?</script>", " ", raw, flags=re.I)
    t = re.sub(r"<style[\s\S]*?</style>", " ", t, flags=re.I)
    t = re.sub(r"<noscript[\s\S]*?</noscript>", " ", t, flags=re.I)
    t = re.sub(r"<!--([\s\S]*?)-->", " ", t)
    t = re.sub(r"<h1[^>]*>([\s\S]*?)</h1>", r"\n# \1\n", t, flags=re.I)
    t = re.sub(r"<h2[^>]*>([\s\S]*?)</h2>", r"\n## \1\n", t, flags=re.I)
    t = re.sub(r"<h3[^>]*>([\s\S]*?)</h3>", r"\n### \1\n", t, flags=re.I)
    t = re.sub(r"<br\s*/?>", "\n", t, flags=re.I)
    t = re.sub(r"</p>", "\n\n", t, flags=re.I)
    t = re.sub(r"</div>", "\n", t, flags=re.I)
    t = re.sub(r"</li>", "\n", t, flags=re.I)
    t = re.sub(r"<li[^>]*>", "- ", t, flags=re.I)
    t = re.sub(
        r'<a[^>]*href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>',
        r"\2 (\1)",
        t,
        flags=re.I,
    )
    t = re.sub(r"<[^>]+>", " ", t)
    t = html.unescape(t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n[ \t]+", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    for noise in [
        "Agent Dashboard",
        "Broker University",
        "Carrier Info",
        "Events",
        "Agent Tools Hub",
        "Retention Toolkit",
        "SEP Tracker",
        "Sign Out",
        "Compliance",
    ]:
        t = re.sub(rf"(?m)^\s*{re.escape(noise)}\s*$", "", t)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


def write_page(name: str) -> tuple[str, int] | None:
    p = HUB_PAGES / name
    if not p.exists():
        print("missing", name)
        return None
    body = html_to_text(p.read_text(encoding="utf-8", errors="replace"))
    if len(body) < 200:
        print("skip thin", name, len(body))
        return None
    key = name.replace(".html", "").replace("_", "-")
    title = key.replace("-", " ").title()
    md = f"""# {title} (Agent Medicare Hub)

Source: Agent Medicare Hub page `{name}`
Imported for Max — answer from this document; if incomplete, say to verify on the live Hub.
Do not invent compliance/SEP/cert rules beyond this text.

---

{body}
"""
    out = OUT / f"{key}.md"
    out.write_text(md, encoding="utf-8")
    print("wrote", out.name, len(md))
    return out.name, len(md)


def write_seps() -> None:
    seps = json.loads(SEP_JSON.read_text(encoding="utf-8"))
    (OUT / "seps.json").write_text(json.dumps(seps, indent=2), encoding="utf-8")
    items = seps.get("items") or []
    lines = [
        "# SEP Tracker Reference (Agent Medicare Hub)",
        "",
        f"Snapshot: generated_at={seps.get('generated_at')} "
        f"last_imported={seps.get('last_imported')} last_updated={seps.get('last_updated')}",
        f"Counts: {json.dumps(seps.get('counts'))}",
        f"Source: {seps.get('source') or seps.get('source_file')}",
        "",
        "Use for Special Enrollment Period questions. Cite SEP code/name and rules from the entry.",
        "For the interactive tracker UI, agents can open Agent Medicare Hub → SEP Tracker.",
        "",
    ]
    for it in items:
        code = it.get("code") or it.get("sep_code") or it.get("id") or ""
        name = it.get("name") or it.get("title") or it.get("sep_name") or ""
        header = " — ".join(x for x in [str(code).strip(), str(name).strip()] if x)
        lines.append(f"## {header or 'SEP entry'}")
        for k, v in it.items():
            if v is None or v == "":
                continue
            if isinstance(v, (dict, list)):
                v = json.dumps(v, ensure_ascii=False)
            lines.append(f"- **{k}**: {v}")
        lines.append("")
    out = OUT / "sep-tracker.md"
    text = "\n".join(lines)
    out.write_text(text, encoding="utf-8")
    print("wrote", out.name, "items", len(items), "chars", len(text))


def write_index(files: list[tuple[str, int]]) -> None:
    lines = [
        "# Agent Medicare Hub knowledge pack for Max",
        "",
        "Max should treat these documents as the bot version of Agent Medicare Hub for:",
        "compliance, SEPs, certifications, Medicaid/LIS, contracting, retention, HRA, carrier contacts, and agent ops.",
        "Plan benefit dollars still come from PLAN DATA in the chat system prompt / THEI grid.",
        "",
        "## Documents",
        "",
    ]
    for name, n in sorted(files):
        lines.append(f"- `hub/{name.replace('.md', '')}` ({n} chars)")
    (OUT / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    files: list[tuple[str, int]] = []
    for name in INCLUDE:
        row = write_page(name)
        if row:
            files.append(row)
    for p in sorted(HUB_PAGES.glob("LINKS-*.md")):
        content = p.read_text(encoding="utf-8", errors="replace")
        out_name = p.name.lower()
        (OUT / out_name).write_text(
            f"# {p.stem} (Agent Medicare Hub)\n\n{content}\n", encoding="utf-8"
        )
        files.append((out_name, len(content)))
        print("wrote", out_name)
    write_seps()
    files.append(("sep-tracker.md", (OUT / "sep-tracker.md").stat().st_size))
    write_index(files)
    print("done", len(list(OUT.glob('*.md'))), "md files")


if __name__ == "__main__":
    main()
