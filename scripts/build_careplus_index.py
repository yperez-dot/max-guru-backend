#!/usr/bin/env python3
"""Build Max's CarePlus provider name index from the 2027 county directory PDFs.

CarePlus (H1019) has no public search Max can call, and the PDFs have no NPIs. Each county
PDF ends with an alphabetical index "Last, First Mid CRED . . . . page". This script turns
those indexes into data/careplus-directory-2027.json, which services/careplusDirectory.js
searches by name. The directory says "This is a partial list" — a name that is NOT in it is
"not confirmed", never Out.

Usage (needs poppler's pdftotext):
  python3 scripts/build_careplus_index.py \
      miamiDade=H1019FLHM01JG27pdf.pdf palmBeach=H1019FLHM01IG27pdf.pdf [broward=H1019FLHM01CG27pdf.pdf]

PDFs: assets.humana.com  H1019FLHM01{JG,CG,IG}27pdf  (Miami-Dade, Broward, Palm Beach).
Re-run when CarePlus republishes (the cover says "updated on MM/DD/YYYY") and commit the JSON.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'data' / 'careplus-directory-2027.json'
LEADER_RE = re.compile(r'^(?P<name>.{3,80}?)\s*(?:\. ){3,}\.?\s*(?P<pages>\d[\d, ]*)$')
CRED_RE = re.compile(r'^(MD|DO|DPM|DMD|DDS|OD|DC|PA|PA-C|ARNP|APRN|NP|FNP|CNM|PHD|PSYD|PSY|LCSW|LMHC|LMFT|CSW|PC|PT|OT|ST|RD|AUD|CP|RN|CRNA|MSW|BCBA|DNP|PHARMD|APN|SLP|PLLC|PLC|PL|LLC|INC|PLLP|MPH|MS|MBA|FACC|FACS)$')
PERSON_CREDS = {'MD', 'DO', 'DPM', 'DMD', 'DDS', 'OD', 'DC', 'ARNP', 'APRN', 'NP', 'FNP', 'CNM', 'PHD', 'PSYD', 'PSY', 'LCSW', 'LMHC', 'LMFT', 'PA-C', 'AUD', 'CRNA', 'DNP', 'PHARMD', 'APN', 'PT', 'OT'}
ORG_WORDS = {'INC', 'LLC', 'CORP', 'CORPORATION', 'GROUP', 'CENTER', 'CENTERS', 'PHARMACY', 'ASSOCIATES', 'SERVICES', 'CLINIC', 'HOSPITAL', 'HEALTH', 'MEDICAL', 'CARE', 'DENTAL', 'INSTITUTE', 'SPECIALISTS', 'PARTNERS', 'HOME', 'FITNESS', 'OF', 'THE', 'AND', '&'}


def pages_of(pdf):
    out = subprocess.run(['pdftotext', str(pdf), '-'], check=True, capture_output=True, text=True).stdout
    return out.split('\f')


def as_of(pages):
    m = re.search(r'updated (?:on|as of)\s*(\d{2}/\d{2}/\d{4})', '\n'.join(pages[:3]))
    return m.group(1) if m else None


def parse_person(name):
    clean = re.sub(r"[^\w\s,'\-.]", ' ', name).strip()
    if re.search(r'\d', clean):
        return None
    if ',' in clean:
        last, rest = clean.split(',', 1)
        toks = rest.replace('.', ' ').split()
        creds = []
        while toks and CRED_RE.match(toks[-1].upper()):
            creds.insert(0, toks.pop())
        if not toks or not last.strip() or len(toks) > 3:
            return None
        if {w.upper() for w in last.split()} & ORG_WORDS or {t.upper() for t in toks} & ORG_WORDS:
            return None
        return {'last': ' '.join(last.split()).upper(), 'first': ' '.join(toks).upper(), 'cred': ' '.join(creds).upper()}
    # "Jose L Ruiz MD PA" / "KARELIA RUIZ MD PA": only when a personal credential is printed.
    toks = clean.replace('.', ' ').split()
    creds = []
    while toks and CRED_RE.match(toks[-1].upper()):
        creds.insert(0, toks.pop())
    if not creds or not ({c.upper() for c in creds} & PERSON_CREDS) or not (2 <= len(toks) <= 4):
        return None
    if {t.upper() for t in toks} & ORG_WORDS:
        return None
    return {'last': toks[-1].upper(), 'first': ' '.join(toks[:-1]).upper(), 'cred': ' '.join(creds).upper()}


def parse_index(pages):
    people = {}
    for pg in pages:
        lines = [l.strip() for l in pg.split('\n') if l.strip()]
        if sum(1 for l in lines if LEADER_RE.match(l)) < 15:
            continue
        prev = ''
        for line in lines:
            m = LEADER_RE.match(line)
            if not m:
                prev = line
                continue
            p = parse_person(m.group('name'))
            # "Gonzalez Perez," / "Carlos DMD . . . 12": the name wrapped onto two printed lines.
            if not p and prev.endswith(','):
                p = parse_person(prev + ' ' + m.group('name'))
            if not p:
                prev = ''
                continue
            prev = ''
            pgs = sorted({int(x) for x in re.findall(r'\d+', m.group('pages'))})
            key = (p['last'], p['first'], p['cred'])
            if key in people:
                people[key]['pages'] = sorted(set(people[key]['pages']) | set(pgs))
            else:
                people[key] = {**p, 'pages': pgs}
    return sorted(people.values(), key=lambda p: (p['last'], p['first']))


def main(args):
    if not args:
        raise SystemExit(__doc__)
    counties = {}
    for a in args:
        key, _, path = a.partition('=')
        pages = pages_of(path)
        people = parse_index(pages)
        counties[key] = {'asOf': as_of(pages), 'source': Path(path).name, 'people': people}
        print(f'{key}: {len(people)} people (as of {counties[key]["asOf"]})')
    OUT.write_text(json.dumps({'carrier': 'CarePlus Health Plans', 'contract': 'H1019', 'partialList': True, 'counties': counties}, separators=(',', ':')))
    print('wrote', OUT)


if __name__ == '__main__':
    main(sys.argv[1:])
