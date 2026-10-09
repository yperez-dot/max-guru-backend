#!/usr/bin/env python3
"""Build Max's HealthSun (H5431) 2027 drug formulary index from the bilingual formulary PDF.

medicare.gov gives HealthSun tiers but never prior auth / step therapy / quantity limits, so
every HealthSun cell read "PA/QL ?". The formulary prints one row per drug:
"<name> <tier> <requirements>". This turns those rows into data/healthsun-formulary-2027.json,
searched by services/healthsunFormulary.js — which supplies PA/ST/QL only; tier and cost stay
medicare.gov's.

Usage (needs poppler's pdftotext):
  python3 scripts/build_healthsun_formulary.py HS-CY-2027-Formulary-Abridged-and-Comprehensive-Rev.-0821.pdf
Source: HealthSun "2027 Formulary List of Covered Drugs", HPMS formulary ID 27026. Re-run when
HealthSun republishes (the cover says "This formulary was updated on MM/DD/YYYY") and commit
the JSON.

Read with `pdftotext -raw`, not `-layout`: in layout mode the tier / requirements columns slide
onto neighbouring rows (tadalafil 10/20 mg came out as tier 2 with 5 mg's limits). Raw order keeps
each row's cells together, but long names and long requirement lists wrap onto extra lines:
  esomeprazole magnesium oral capsule delayed
  release (rx)
  2 QL (30 per 30 days); MO; 90D
"""
import json
import re
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'data' / 'healthsun-formulary-2027.json'

# One requirement token, as the "Abbreviations" table (p. 9) defines them.
# QL quantities can be decimals: teriparatide "QL (2.24 per 28 days)", "QL (0.5 per 28 days)".
FLAG = r'(?:B/D PA|PA|ST|QL \([\d.]+ per \d+ days?\)|ED|MO|90D|100D|HRM|LA|NEDS|NM)'
REQ_RE = re.compile(rf'^{FLAG}(?:;\s*{FLAG})*;?$')
# "<name> <tier> <requirements>" — the name part may be empty when it wrapped onto earlier lines.
ROW_RE = re.compile(rf'^(?P<name>.*?)(?:^|\s)(?P<tier>[1-6])(?:\s+(?P<req>{FLAG}(?:;\s*{FLAG})*;?))?$')
UNIT_START_RE = re.compile(r'^(?:mg|mcg|ml|gm|g\b|%|unit|units|meq|mg/|mcg/)', re.I)
BOILERPLATE_RE = re.compile(
    r'^(?:You can find information|to page \d|s.mbolos y abreviaciones|HealthSun 2027 - Formulary|'
    r'DRUG NAME / NOMBRE|TIER /|NIVEL$|REQUIREMENTS / LIMITS|REQUISITOS / LIMITACIONES|\d+$|-$)'
)
ASOF_RE = re.compile(r'formulary was updated on\s*(\d{1,2}/\d{1,2}/\d{4})', re.I)
ID_RE = re.compile(r'Formulary ID (\d+), Version (\d+)')
PLAN_RE = re.compile(r'^(H\d{4}-\d{3})$')


def is_category(line):
    """ "ANALGESICS AND ANTI-INFLAMMATORY AGENTS /" and its Spanish second line."""
    letters = re.sub(r'[^A-Za-z]', '', line)
    return bool(letters) and letters.isupper() and (
        'AGENT' in line or ' / ' in line or line.rstrip().endswith('/') or 'VITAMIN' in line or 'TRATAMIENTO' in line
    )


def parse_flags(req):
    tokens = [t.strip() for t in re.split(r';\s*', req or '') if t.strip()]
    ql = next((t for t in tokens if t.startswith('QL')), None)
    m = re.match(r'QL \(([\d.]+) per (\d+) days?\)', ql or '')
    return {
        'pa': 'PA' in tokens,
        'bdPa': 'B/D PA' in tokens,
        'st': 'ST' in tokens,
        'ql': bool(ql),
        'qlText': f'QL {m.group(1)}/{m.group(2)}' if m else None,
        'ed': 'ED' in tokens,
        'hrm': 'HRM' in tokens,
        'la': 'LA' in tokens,
        'neds': 'NEDS' in tokens,
        'mo': 'MO' in tokens,
        'days90': '90D' in tokens,
        'days100': '100D' in tokens,
    }


def parse_rows(lines):
    rows = []
    buf = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        i += 1
        if not line:
            continue
        if BOILERPLATE_RE.match(line) or is_category(line):
            buf = []
            continue
        m = ROW_RE.match(line)
        nxt = lines[i].strip() if i < len(lines) else ''
        # "…oral tablet 1 mg, 5" then "mg": a strength that wrapped, not a tier.
        if m and m.group('name').rstrip().endswith((',', '-', '/')):
            m = None
        if m and not m.group('req') and UNIT_START_RE.match(nxt):
            m = None
        if not m:
            buf.append(line)
            buf = buf[-3:]
            continue
        name = ' '.join(buf + [m.group('name').strip()]).strip()
        buf = []
        req = (m.group('req') or '').strip()
        # Requirements that wrapped: "2" / "PA; QL (900 per 30 days); NEDS;" / "HRM".
        while i < len(lines) and REQ_RE.match(lines[i].strip()) and (not req or req.endswith(';')):
            req = f'{req} {lines[i].strip()}'.strip()
            i += 1
        req = req.rstrip(';').strip()
        if not name:
            continue
        rows.append({'name': re.sub(r'\s+', ' ', name), 'tier': int(m.group('tier')), 'req': req, **parse_flags(req)})
    return rows


def main(pdf):
    text = subprocess.run(['pdftotext', '-raw', str(pdf), '-'], check=True, capture_output=True, text=True, encoding='latin-1').stdout
    lines = text.split('\n')
    start = next(n for n, l in enumerate(lines) if l.startswith('ANALGESICS AND ANTI-INFLAMMATORY AGENTS'))
    end = next(n for n, l in enumerate(lines) if l.startswith('Index / '))
    plans = sorted({m.group(1) for l in lines[:start] for m in [PLAN_RE.match(l.strip())] if m})
    head = '\n'.join(lines[:120])
    asof = (ASOF_RE.search(head) or [None, None])[1]
    fid = ID_RE.search(head)
    rows = parse_rows(lines[start:end])
    out = {
        'carrier': 'HealthSun Health Plans',
        'contract': 'H5431',
        'plans': plans,
        'year': 2027,
        'asOf': asof,
        'formularyId': fid.group(1) if fid else None,
        'version': fid.group(2) if fid else None,
        'source': Path(pdf).name,
        'rows': rows,
    }
    OUT.write_text(json.dumps(out, indent=1) + '\n', encoding='utf-8')
    print(f'{len(rows)} rows, {len(plans)} plans, updated {asof}, ID {out["formularyId"]} v{out["version"]} -> {OUT}')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
