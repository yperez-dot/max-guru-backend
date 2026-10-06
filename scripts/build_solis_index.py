#!/usr/bin/env python3
"""Build Max's Solis provider index from the county directory PDFs.

Solis (H0982) has no working live search (its 2027 search API returns HTTP 500)
and no NPIs in the PDFs. Each county PDF ends with an alphabetical index:
"LAST, FIRST CRED ...... page". This script turns those indexes into
data/solis-directory-2027.json, which services/solisDirectory.js searches.

Usage (needs poppler's pdftotext):
  python3 scripts/build_solis_index.py \
      miamiDade=ProvDirecMD_All_Next.pdf \
      browardPalmBeach=ProvDirecBDPB_All_Next.pdf \
      centralFl=ProvDirecCFL_All_Next.pdf

PDFs: https://soliscdrapi.azurewebsites.net/doc/ProvDirec{MD,BDPB,CFL}_All_Next (2027).
Re-run monthly (the PDF says "current as of …") and commit the JSON.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'data' / 'solis-directory-2027.json'
INDEX_MARK = 'Solis Health Plans - Index'
ENTRY_RE = re.compile(r'^(?P<name>.+?)\s*(?:\.{2,}\s*)?(?P<pages>\d{1,3}(?:\s*,\s*\d{1,3})*)$')
# Credentials/licence tails as printed in the directory.
CRED_RE = re.compile(r'^(MD|DO|DPM|DMD|DDS|OD|DC|PA|PA-C|ARNP|APRN|NP|FNP|CNM|PHD|PSYD|PSY|LCSW|LMHC|LMFT|CSW|PC|PT|OT|ST|RD|AUD|CP|RN|LPN|CRNA|MSW|BCBA|OTR|DNP|PHARMD|APN|HAS|SLP|CCC-SLP|LMT|MT|LAC|AP|DOM|DT|ACU|NEU|NMW|MW|CNA|HHA|ATC|CCC|LD|LDN|RDN)$')
ORG_WORDS = {'INC', 'LLC', 'CORP', 'CORPORATION', 'PLLC', 'LTD', 'CO', 'GROUP', 'CENTER', 'PHARMACY', 'ASSOCIATES', 'SERVICES', 'CLINIC'}


def pdf_text(path):
    return subprocess.run(['pdftotext', '-layout', str(path), '-'], check=True, capture_output=True, text=True).stdout


def as_of(text):
    m = re.search(r'current as of ([A-Z][a-z]+ \d{1,2}, \d{4})', text)
    return m.group(1) if m else None


def parse_person(name):
    """'DEL CONDE POZZI, IAN MD' → last, first, cred. Organizations (no comma) → None."""
    clean = re.sub(r'[^\w\s,\'\-.]', ' ', name).strip()
    if ',' not in clean:
        return None
    last, rest = clean.split(',', 1)
    toks = rest.replace('.', ' ').split()
    creds = []
    while toks and CRED_RE.match(toks[-1].upper()):
        creds.insert(0, toks.pop())
    if not toks or not last.strip():
        return None
    words = set(last.upper().split()) | set(t.upper() for t in toks)
    # Companies ("ADVANCE THERAPY CENTER, INC.") and footer text are not people.
    if words & ORG_WORDS or re.search(r'\d', last + ' '.join(toks)) or len(toks) > 3:
        return None
    return {'last': ' '.join(last.split()).upper(), 'first': ' '.join(toks).upper(), 'cred': ' '.join(creds).upper()}


def parse_index(text):
    start = text.find(INDEX_MARK)
    if start < 0:
        raise SystemExit('no alphabetical index found')
    people = {}
    for line in text[start:].split('\n'):
        for cell in re.split(r'\s{3,}', line.strip()):
            m = ENTRY_RE.match(cell.strip())
            if not m:
                continue
            p = parse_person(m.group('name'))
            if not p:
                continue
            pages = sorted({int(x) for x in re.findall(r'\d+', m.group('pages'))})
            key = (p['last'], p['first'], p['cred'])
            if key in people:
                people[key]['pages'] = sorted(set(people[key]['pages']) | set(pages))
            else:
                people[key] = {**p, 'pages': pages}
    return sorted(people.values(), key=lambda p: (p['last'], p['first']))


def main(args):
    data = {'year': 2027, 'source': 'Solis Health Plans county provider directory PDFs (alphabetical index)', 'counties': {}}
    if OUT.exists():
        data = json.loads(OUT.read_text())
    for arg in args:
        key, path = arg.split('=', 1)
        text = pdf_text(path)
        people = parse_index(text)
        data['counties'][key] = {'asOf': as_of(text), 'file': Path(path).name, 'people': people}
        print(f'{key}: {len(people)} people, current as of {as_of(text)}')
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(data, separators=(',', ':')))
    print(f'wrote {OUT} ({OUT.stat().st_size // 1024} KB)')


if __name__ == '__main__':
    main(sys.argv[1:])
