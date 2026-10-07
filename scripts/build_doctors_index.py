#!/usr/bin/env python3
"""Build Max's Doctors HealthCare Plans (H4140) NPI index from the 2027 county directory PDFs.

Each listing prints "ID: PC0048778 / NPI: 1407095615" right under the provider name, so unlike
Solis/CarePlus this is an exact NPI match. Output: data/doctors-directory-2027.json, read by
services/doctorsHcp.js before it calls the live site (which Railway cannot always reach).

Usage (needs poppler's pdftotext):
  python3 scripts/build_doctors_index.py miamiDade=dade.pdf broward=broward.pdf tampa=tampa.pdf orlando=orlando.pdf [polk=polk.pdf]
Re-run when Doctors republishes ("current as of ...") and commit the JSON.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'data' / 'doctors-directory-2027.json'
NPI_RE = re.compile(r'NPI:\s*(\d{10})')
ASOF_RE = re.compile(r'current as of ([A-Z][a-z]+ \d{1,2}, \d{4})')


def pages_of(pdf):
    out = subprocess.run(['pdftotext', str(pdf), '-'], check=True, capture_output=True, text=True).stdout
    return out.split('\f')


def main(args):
    counties = {}
    for arg in args:
        key, _, path = arg.partition('=')
        pages = pages_of(path)
        m = ASOF_RE.search('\n'.join(pages[:3]))
        npis = {}
        for i, pg in enumerate(pages, start=1):
            lines = pg.split('\n')
            for j, line in enumerate(lines):
                for npi in NPI_RE.findall(line):
                    if npi not in npis:
                        npis[npi] = i  # PDF page number (not the printed page)
        counties[key] = {'asOf': m.group(1) if m else None, 'source': Path(path).name, 'npis': npis}
        print(f'{key}: {len(npis)} NPIs, as of {counties[key]["asOf"]}', file=sys.stderr)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({'plan': 'Doctors HealthCare Plans (H4140)', 'counties': counties}, separators=(',', ':')))


if __name__ == '__main__':
    main(sys.argv[1:])
