#!/usr/bin/env python3
"""Confirmed vs yellow 2027 cell rules."""

from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from thei_grid_common import (  # noqa: E402
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


if __name__ == "__main__":
    unittest.main()
