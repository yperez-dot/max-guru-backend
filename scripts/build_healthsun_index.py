#!/usr/bin/env python3
"""Build Max's HealthSun (H5431) 2027 provider name index from the provider directory PDF.

HealthSun's live FHIR directory answers at carrier level only, so every HealthSun cell read
"not confirmed". The 2027 Provider and Pharmacy Directory (one PDF for Miami-Dade, Broward and
Palm Beach) has NO NPIs, but ends with an alphabetical Provider Index: "Last, First M. , CRED"
followed by printed page numbers. This script turns it into data/healthsun-directory-2027.json,
searched by services/healthsunDirectory.js by name (same rules as Solis / CarePlus).

County comes from the body pages: every body page starts with "<County> County / Condado …" and
ends with its printed page number (printed = PDF page - 1). An index entry belongs to every
county whose pages it lists.

Usage (needs poppler's pdftotext):
  python3 scripts/build_healthsun_index.py ProviderDirectory.pdf
Re-run when HealthSun republishes ("current as of …" on the cover) and commit the JSON.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / 'data' / 'healthsun-directory-2027.json'
# Provider body pages are headed "Broward County / Condado Broward". The pharmacy section's
# opener is a bare "Broward County/", and index entries can start with a facility name such as
# "Broward County Health Dept" — neither may count as a provider body page.
COUNTY_RE = re.compile(r'^\s*(Miami-Dade|Broward|Palm Beach) County\s*/\s*Condado')
SECTION_OPENER_RE = re.compile(r'^\s*(Miami-Dade|Broward|Palm Beach) County\s*/\s*$')
COUNTY_KEY = {'Miami-Dade': 'miamiDade', 'Broward': 'broward', 'Palm Beach': 'palmBeach'}
PAGES_RE = re.compile(r'^\s*\d{1,4}(?:\s*,\s*\d{1,4})*\s*$')
ASOF_RE = re.compile(r'current as of ([A-Z][a-z]+ \d{1,2}, \d{4})')
CRED_RE = re.compile(r'^(MD|DO|DPM|DMD|DDS|OD|DC|PA|PA-C|ARNP|APRN|NP|FNP|CNM|PHD|PSYD|PSY|LCSW|LMHC|LMFT|CSW|PT|OT|ST|RD|AUD|CP|RN|CRNA|MSW|BCBA|DNP|PHARMD|APN|SLP|CCC-SLP|LD|LDN|RDN|MS|MPH|AU\.D|AUD|AT|ATC)$', re.I)


def page_texts(pdf):
    out = subprocess.run(['pdftotext', str(pdf), '-'], check=True, capture_output=True, text=True).stdout
    return out.split('\f')


def county_by_printed_page(pages):
    """{printed page number: county key} from the provider body pages' header + footer."""
    # Only some body pages repeat the county header; the sections are contiguous, so a page with
    # no header belongs to the county last named.
    m = {}
    current = None
    for i, text in enumerate(pages, start=1):
        lines = [l for l in text.split('\n') if l.strip()]
        if not lines:
            continue
        c = COUNTY_RE.match(lines[0])
        if c:
            current = COUNTY_KEY[c.group(1)]
        if not current:
            continue  # front matter before the first county section
        last = lines[-1].strip()
        printed = int(last) if last.isdigit() else i - 1
        m[printed] = current
    return m


def first_line(text):
    return next((l for l in text.split('\n') if l.strip()), '')


def index_bounds(pages):
    """(start, end) 0-based page slice of the alphabetical Provider Index.

    The book runs: provider body pages (each headed "<County> County / …") → the Provider Index
    → Pharmacies, whose pages ALSO carry county headers. So the index begins right after the last
    county-headed page that comes BEFORE the first "Pharmacies" page, and ends at that page.
    """
    pharm = next((i for i, t in enumerate(pages) if first_line(t).strip().startswith('Pharmacies')), len(pages))
    while pharm > 0 and SECTION_OPENER_RE.match(first_line(pages[pharm - 1])):
        pharm -= 1
    last_body = max((i for i, t in enumerate(pages[:pharm]) if COUNTY_RE.match(first_line(t))), default=-1)
    return last_body + 1, pharm


def parse_person(raw):
    """'Ead, Daniel N. , MD' → {last, first, cred}. Facilities (no comma) → None."""
    name = re.sub(r'[¹²³⁴⁵⁶⁷⁸⁹⁰*]+', '', raw).strip()
    if ',' not in name:
        return None
    parts = [p.strip() for p in name.split(',') if p.strip()]
    if len(parts) < 2:
        return None
    last = parts[0]
    rest = parts[1:]
    creds = []
    while rest and all(CRED_RE.match(t) for t in rest[-1].replace('.', ' ').split()):
        creds.insert(0, rest.pop())
    if not rest:
        return None
    first = ' '.join(rest).replace('.', ' ')
    first = re.sub(r'\s+', ' ', first).strip()
    if not first or re.search(r'\d', first) or re.search(r'\d', last):
        return None
    # Organizations that happen to contain a comma ("Smith, Jones And Associates, LLC").
    if re.search(r'\b(LLC|INC|CORP|GROUP|CENTER|ASSOCIATES|SERVICES|CLINIC|PA|PLLC)\b', last, re.I) and not creds:
        return None
    return {
        'last': re.sub(r'\s+', ' ', last).upper(),
        'first': first.upper(),
        'cred': ' '.join(creds).replace('.', '').upper(),
    }


def parse_index(pages, start, end):
    entries = []
    lines = []
    for text in pages[start:end]:
        lines.extend(l.strip() for l in text.split('\n'))
    lines = [l for l in lines if l]
    i = 0
    while i < len(lines) - 1:
        name, nxt = lines[i], lines[i + 1]
        if PAGES_RE.match(nxt) and not PAGES_RE.match(name) and len(name) > 2:
            pages_ = [int(p) for p in re.findall(r'\d+', nxt)]
            entries.append((name, pages_))
            i += 2
            continue
        i += 1
    return entries


def main(pdf):
    pages = page_texts(pdf)
    start, end = index_bounds(pages)
    county_of = county_by_printed_page(pages[:start])
    as_of = ASOF_RE.search('\n'.join(pages[:4]))
    counties = {k: {'asOf': as_of.group(1) if as_of else None, 'source': Path(pdf).name, 'people': []}
                for k in COUNTY_KEY.values()}
    seen = {k: {} for k in counties}
    people = facilities = unplaced = 0
    for raw, pgs in parse_index(pages, start, end):
        p = parse_person(raw)
        if not p:
            facilities += 1
            continue
        people += 1
        by_county = {}
        for pg in pgs:
            c = county_of.get(pg)
            if c:
                by_county.setdefault(c, []).append(pg)
        if not by_county:
            unplaced += 1
            continue
        for c, cpages in by_county.items():
            key = (p['last'], p['first'], p['cred'])
            if key in seen[c]:
                seen[c][key]['pages'] = sorted(set(seen[c][key]['pages'] + cpages))
            else:
                entry = {**p, 'pages': sorted(set(cpages))}
                seen[c][key] = entry
                counties[c]['people'].append(entry)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({'plan': 'HealthSun Health Plans (H5431)', 'counties': counties}, separators=(',', ':')))
    print(
        f'{people} people ({facilities} facilities skipped, {unplaced} with no county page); '
        + ', '.join(f'{k} {len(v["people"])}' for k, v in counties.items())
        + f'; as of {counties["miamiDade"]["asOf"]}',
        file=sys.stderr,
    )


if __name__ == '__main__':
    main(sys.argv[1])
