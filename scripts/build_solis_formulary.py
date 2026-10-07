#!/usr/bin/env python3
"""Build Max's Solis (H0982) 2027 drug formulary index from the comprehensive formulary PDF.

Solis is not on Sunfire, so drug tiers for Solis plans came back "not confirmed". The PDF
prints one row per drug: "<name> <tier> <requirements>". This turns those rows into
data/solis-formulary-2027.json, searched by services/solisFormulary.js.

Usage (needs poppler's pdftotext):
  python3 scripts/build_solis_formulary.py solis-formulary-2027.pdf
Source: Solis "Comprehensive Formulary" H0982_formulary27_C. Re-run when Solis republishes
(the cover says "The Formulary was updated on MM/DD/YYYY") and commit the JSON.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'data' / 'solis-formulary-2027.json'
# "ORGOVYX - relugolix tab 120 mg*   5   PA, QL (90 tablets/30 days)"
ROW_RE = re.compile(r'^(?P<name>\S.{2,90}?)\s{2,}(?P<tier>[1-6])(?:\s{2,}(?P<req>\S.*?))?\s*$')
ASOF_RE = re.compile(r'Formulary was updated on\s*(\d{2}/\d{2}/\d{4})')
YEAR_RE = re.compile(r'formulary(\d{2})_', re.I)
SKIP_RE = re.compile(r'^(?:drug name|nombre|non medikaman|tier|nivo|requirements|requisitos|egzijans)', re.I)


def norm(name):
    """Lower-case search key: drop the brand prefix, trailing footnote marks, dose and form."""
    s = name.strip().lower()
    s = re.sub(r'[*^#†‡]+', '', s)
    s = re.sub(r'\s+', ' ', s)
    return s.strip(' -')


SALTS = r'(?:hcl|hydrochloride|besylate|calcium|magnesium|sodium|potassium|sulfate|succinate|tartrate|maleate|mesylate|fumarate|citrate|acetate|phosphate|bitartrate|dihydrate|monohydrate|base equivalent)'
FORMS = r'\b(?:tab|tabs|cap|caps|soln|susp|inj|cream|gel|film|er|dr|oint|spray|patch|kit|pack|powd|syrup|supp|neb|chew|conc|lotion|foam|drops|aerosol|solution|capsule|tablet)\b'


def keys_for(name):
    """Every way an agent might type this drug: brand, generic, and generic without its salt."""
    out = set()
    full = norm(name)
    out.add(full)
    brand, generic = None, full
    if ' - ' in full:
        brand, generic = full.split(' - ', 1)
        out.add(brand.strip())
    for part in (brand, generic):
        if not part:
            continue
        stem = re.split(FORMS, part)[0]
        stem = re.sub(r'\d.*$', '', stem).strip(' -,')
        if not stem:
            continue
        out.add(stem)
        bare = re.sub(rf'\s+{SALTS}$', '', stem).strip()
        if bare:
            out.add(bare)
        # Combos print a salt on each half ("amlodipine besylate-benazepril hcl") — an agent
        # types "amlodipine-benazepril", so index that shape too.
        if '-' in stem:
            parts = [re.sub(rf'\s+{SALTS}$', '', p_).strip() for p_ in stem.split('-')]
            parts = [p_ for p_ in parts if p_]
            if len(parts) > 1:
                out.add('-'.join(parts))
    return {k for k in out if len(k) > 2}


def main(pdf):
    text = subprocess.run(['pdftotext', '-layout', str(pdf), '-'], check=True, capture_output=True, text=True).stdout
    head = '\n'.join(text.split('\n')[:80])
    as_of = ASOF_RE.search(text)
    ym = YEAR_RE.search(text)
    drugs = {}
    for line in text.split('\n'):
        m = ROW_RE.match(line.rstrip())
        if not m:
            continue
        name = m.group('name').strip()
        if SKIP_RE.match(name) or not re.search(r'[a-z]', name):
            continue
        entry = {'name': name, 'tier': int(m.group('tier')), 'req': (m.group('req') or '').strip()}
        for k in keys_for(name):
            # Lowest tier wins for a shared stem, so a loose match never overstates cost.
            if k not in drugs or entry['tier'] < drugs[k]['tier']:
                drugs[k] = entry
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({
        'plan': 'Solis Health Plans (H0982)',
        'year': 2000 + int(ym.group(1)) if ym else None,
        'asOf': as_of.group(1) if as_of else None,
        'source': Path(pdf).name,
        'drugs': drugs,
    }, separators=(',', ':')))
    print(f'{len(drugs)} keys, year {2000 + int(ym.group(1)) if ym else "?"}, as of {as_of.group(1) if as_of else "?"}', file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1])
