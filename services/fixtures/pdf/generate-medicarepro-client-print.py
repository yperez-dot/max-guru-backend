#!/usr/bin/env python3
"""Build the fictional MedicarePro Client Print PDF fixture.

Layout matches the CRM print (letterhead, Plans / Providers / Prescription Drugs /
Pharmacies / Rx Cards cut-outs, medicareproapp.com footers). Names, CRM IDs and
pharmacy details are invented — do not replace with a real client print.
"""
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

OUT = Path(__file__).with_name("intake-medicarepro-client-print.pdf")
W, H = letter
FOOTER = (
    "https://www.medicareproapp.com/agent/profileController/clientPrint/"
    "overview=1,plan=1,pro=1,rx=1,pharmacy=1,questionnaire=1,rxCutOut=1,logo=1,"
    "labelPos=,ind_id=1000001,spouse_id=1000002"
)
DRUGS = [
    "alprazolam 0.25 MG Oral Tablet",
    "atorvastatin 20 MG Oral Tablet",
    "meloxicam 15 MG Oral Tablet",
    "meloxicam 5 MG Oral Capsule",
    "24 HR oxcarbazepine 600 MG Extended Release Oral Tablet",
    "sertraline 50 MG Oral Tablet",
    "triamcinolone acetonide 0.00025 MG/MG Topical Ointment",
]
PROVIDERS = [
    "MARTA SOLANO RUIZ (PCP)",
    "Luis Herrera (Dentist)",
    "Marco Vidal (Urologist)",
    "Elena Castro (Cardiologist)",
    "Tomas Navarro (Neurologist)",
    "Rosa Benitez (Dermatologist)",
    "Pablo Rivas (Gastroenterologist)",
    "Coral Eyes (Optometrist)",
    "Diego Molina (PCP)",
]


def header(c, page, pages=4):
    c.setFont("Helvetica", 8)
    c.drawString(36, H - 28, "11/22/26, 8:41 AM")
    c.drawRightString(W - 36, H - 28, "Client Print")
    c.setFont("Helvetica", 7)
    url_y = 28
    c.drawString(36, url_y, FOOTER)
    c.drawRightString(W - 36, url_y, f"{page}/{pages}")


def page1(c):
    header(c, 1)
    c.setFont("Helvetica-Bold", 11)
    c.drawRightString(W - 48, H - 72, "Marina Solano")
    c.setFont("Helvetica", 9)
    intro = [
        "Below is a list of your annual healthcare information that you",
        "helped me gather. You will see your current healthcare plan(s)",
        "along with a listing of your current providers and prescription",
        "drugs. Also, I included a handy drug sheet that you can cut out",
        "and keep with you. If you have any questions please contact",
        "me.",
    ]
    y = H - 92
    for line in intro:
        c.drawRightString(W - 48, y, line)
        y -= 12

    c.setFont("Helvetica", 9)
    ax, ay = 70, H - 104
    for line in [
        "Camila Romero",
        "Co-Owner & Health Insurance",
        "Agent",
        "The Health Experts Insurance",
        "(305) 555-0148",
        "cromero@example.com",
        "1695 NW 110 AVE 224 DORAL, FL 33172",
    ]:
        c.drawString(ax, ay, line)
        ay -= 12

    y = H - 250
    c.setFont("Helvetica-Bold", 10)
    c.drawString(54, y, "Plans")
    y -= 16
    c.setFont("Helvetica", 9)
    c.drawString(70, y, "Devoted Health")
    y -= 14
    for line in [
        "Plan Name: DEVOTED CORE 062 FL (HMO)",
        "Effective Date: Jan 1, 2026",
        "Status: Active",
        "Plan Type: Medicare Advantage",
    ]:
        c.drawString(84, y, line)
        y -= 13

    y -= 18
    c.setFont("Helvetica-Bold", 10)
    c.drawString(54, y, "Providers")
    y -= 16
    c.setFont("Helvetica", 9)
    for name in PROVIDERS:
        c.drawString(70, y, name)
        y -= 16

    y -= 8
    c.setFont("Helvetica-Bold", 10)
    c.drawString(54, y, "Prescription Drugs")
    y -= 16
    c.setFont("Helvetica", 9)
    for drug in DRUGS[:5]:
        c.drawString(70, y, drug)
        y -= 16


def page2(c):
    header(c, 2)
    y = H - 56
    c.setFont("Helvetica", 9)
    for drug in DRUGS[5:]:
        c.drawString(70, y, drug)
        y -= 16

    y -= 12
    c.setFont("Helvetica-Bold", 10)
    c.drawString(54, y, "Pharmacies")
    y -= 18
    c.setFont("Helvetica", 9)
    for name, addr, phone in [
        ("WALGREENS #01999", "Address: 12345 SW 200TH ST HOMESTEAD, FL 33032", "Phone: (305) 246-0100"),
        ("CVS PHARMACY #08888", "Address: 9876 S DIXIE HWY HOMESTEAD, FL 33033", "Phone: (305) 247-0200"),
    ]:
        c.drawString(70, y, name)
        y -= 13
        c.drawString(84, y, addr)
        y -= 13
        c.drawString(84, y, phone)
        y -= 20


def cutout(c, x, y, extra_col=True):
    c.setFont("Helvetica-Bold", 9)
    c.drawString(x, y, "My Drug List")
    y -= 16
    c.setFont("Helvetica", 8)
    c.drawString(x, y, "Drug Name")
    c.drawString(x + 280, y, "Dosage")
    c.drawString(x + 340, y, "Frequency")
    if extra_col:
        c.drawString(x + 410, y, "Per")
    y -= 14
    c.setFont("Helvetica", 9)
    for drug in DRUGS:
        c.drawString(x + 18, y, drug)
        y -= 12
    return y


def page3(c):
    header(c, 3)
    y = H - 64
    c.setFont("Helvetica-Bold", 10)
    c.drawString(54, y, "Rx Cards")
    y -= 22
    y = cutout(c, 70, y, extra_col=True)
    y -= 18
    cutout(c, 70, y, extra_col=False)


def page4(c):
    header(c, 4)


def main():
    c = canvas.Canvas(str(OUT), pagesize=letter)
    page1(c)
    c.showPage()
    page2(c)
    c.showPage()
    page3(c)
    c.showPage()
    page4(c)
    c.save()
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
