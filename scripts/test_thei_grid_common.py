#!/usr/bin/env python3
"""Confirmed vs yellow 2027 cell rules."""

from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from thei_grid_common import (  # noqa: E402
    cell_caption,
    cell_link,
    clean_plan_marketing_name,
    extract_plan_id,
    is_confirmed_2027_cell,
    is_green,
    is_healthspring_dade_broward,
    is_yellow,
    resolve_2027_sheets,
)


def _cell(value, rgb=None):
    fg = None
    if rgb:
        fg = SimpleNamespace(type="rgb", rgb=rgb)
    fill = SimpleNamespace(fill_type="solid" if rgb else None, fgColor=fg)
    return SimpleNamespace(value=value, fill=fill)


class ConfirmedCellTests(unittest.TestCase):
    def test_yellow_is_never_confirmed(self):
        self.assertTrue(is_yellow(_cell(9250, "FFFFF2CC")))
        self.assertFalse(is_confirmed_2027_cell(_cell(9250, "FFFFF2CC")))
        self.assertFalse(is_confirmed_2027_cell(_cell("$9,250", "FFFFFF00")))

    def test_white_working_cell_is_confirmed(self):
        self.assertTrue(is_confirmed_2027_cell(_cell("$0", "FFFFFFFF")))
        self.assertTrue(is_confirmed_2027_cell(_cell(0, None)))

    def test_classic_green_still_confirmed(self):
        cell = _cell("$0", "FFE8F5E9")
        self.assertTrue(is_green(cell))
        self.assertTrue(is_confirmed_2027_cell(cell))

    def test_empty_not_confirmed(self):
        self.assertFalse(is_confirmed_2027_cell(_cell("", "FFFFFFFF")))
        self.assertFalse(is_confirmed_2027_cell(_cell(None, "FFE8F5E9")))

    def test_healthspring_skip(self):
        self.assertTrue(is_healthspring_dade_broward("HealthSpring", "H5410-060", "Miami-Dade"))
        self.assertTrue(is_healthspring_dade_broward("UHC", "H5410-056", "Broward"))
        self.assertFalse(is_healthspring_dade_broward("Humana", "H1036-054C", "Miami-Dade"))


class SheetResolveTests(unittest.TestCase):
    def test_prefers_full_partial_over_legacy(self):
        wb = SimpleNamespace(
            sheetnames=[
                "DADE- HMO",
                "Dade- DSNP Full",
                "Dade- DSNP Partial",
                "Dade- DSNP",
                "BWD-DSNP Full",
                "BWD-DSNP",
            ]
        )
        sheets = resolve_2027_sheets(wb)
        names = [s[0] for s in sheets]
        self.assertIn("Dade- DSNP Full", names)
        self.assertIn("Dade- DSNP Partial", names)
        self.assertNotIn("Dade- DSNP", names)
        self.assertNotIn("BWD-DSNP", names)



class GridLinkTests(unittest.TestCase):
    def test_hyperlink_formula_is_a_link(self):
        f = '=HYPERLINK("https://goldkidney.com/x/Y0171_H1526002_EOC_0926_M.pdf","EOC — Heart & Diabetes")'
        cell = SimpleNamespace(value=f, hyperlink=None)
        self.assertEqual(cell_link(cell), "https://goldkidney.com/x/Y0171_H1526002_EOC_0926_M.pdf")
        self.assertEqual(cell_caption(f), "EOC — Heart & Diabetes")

    def test_cell_hyperlink_and_bare_url(self):
        cell = SimpleNamespace(value="SOB", hyperlink=SimpleNamespace(target=" https://a/b "))
        self.assertEqual(cell_link(cell), "https://a/b")
        self.assertEqual(cell_link(SimpleNamespace(value="https://c/d", hyperlink=None)), "https://c/d")
        self.assertIsNone(cell_link(SimpleNamespace(value="EOC pending", hyperlink=None)))

    def test_plan_id_glued_to_a_word(self):
        self.assertEqual(
            extract_plan_id("UHC Preferred Dual Complete FL-Y6 HMO-POS-DSNPH1045-063"), "H1045-063"
        )
        self.assertEqual(extract_plan_id("Wellcare H1032-250 **NEW 2027**"), "H1032-250")
        self.assertEqual(extract_plan_id("Devoted H129-002"), "H129-002")


class CleanPlanMarketingNameTest(unittest.TestCase):
    """Grid working tags are not part of the plan name (2026-10-20)."""

    def test_new_2027_variants(self):
        for raw in (
            "Humana Choice Giveback **NEW 2027",
            "Humana Choice Giveback **NEW 2027**",
            "Humana Choice Giveback NEW 2027**",
            "Humana Choice Giveback (NEW 2027)",
            "Humana Choice Giveback - NEW 2027",
            "Humana Choice Giveback new 2027",
            "**Humana Choice Giveback**",
            "NEW 2027 - Humana Choice Giveback",
        ):
            self.assertEqual(clean_plan_marketing_name(raw), "Humana Choice Giveback", raw)
        self.assertEqual(clean_plan_marketing_name("Doctors DrExtraCare NEW"), "Doctors DrExtraCare")
        self.assertEqual(
            clean_plan_marketing_name("Wellcare Dual Align Unity (HMO D-SNP) NEW 2027"),
            "Wellcare Dual Align Unity (HMO D-SNP)",
        )

    def test_r0759_001_keeps_non_commissionable(self):
        self.assertEqual(
            clean_plan_marketing_name("AARP UHC Regional PPO FL-0031 NON-COMMISSIONABLE"),
            "AARP UHC Regional PPO FL-0031 NON-COMMISSIONABLE",
        )
        self.assertEqual(
            clean_plan_marketing_name("AARP UHC Regional PPO FL-0031 **NON-COMMISSIONABLE**"),
            "AARP UHC Regional PPO FL-0031 NON-COMMISSIONABLE",
        )

    def test_ids_and_other_text_untouched(self):
        for s in ("UHC MedicareMax FL-0028", "Humana Gold Plus H1036-054C", "Brand New Plan", "CLOSED TO NEW ENROLL 2027"):
            self.assertEqual(clean_plan_marketing_name(s), s)


if __name__ == "__main__":
    unittest.main()
