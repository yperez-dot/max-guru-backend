#!/usr/bin/env python3
"""Unit tests for dental procedure export / sibling-fill helpers."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dental_procedure_rows import (
    apply_curated_dental,
    apply_curated_on_plan_objects,
    apply_sibling_dental_fill,
    apply_sibling_dental_on_plan_objects,
    is_clear_dental_value,
    is_dental_procedure_label,
    is_junk_dental_value,
)


class DentalValueTests(unittest.TestCase):
    def test_labels(self):
        self.assertTrue(is_dental_procedure_label("Crowns"))
        self.assertTrue(is_dental_procedure_label("  Bridges"))
        self.assertTrue(is_dental_procedure_label("Dental Implants"))
        self.assertFalse(is_dental_procedure_label("Dental"))
        self.assertFalse(is_dental_procedure_label("Premium"))

    def test_junk_vs_clear(self):
        self.assertTrue(is_junk_dental_value("$0\nvaries"))
        self.assertTrue(is_junk_dental_value("$0 varies"))
        self.assertTrue(is_junk_dental_value("Not listed"))
        self.assertTrue(is_junk_dental_value(0))
        self.assertTrue(is_junk_dental_value('"'))
        self.assertTrue(is_clear_dental_value("2 every 5 years"))
        self.assertTrue(is_clear_dental_value("Yes"))
        self.assertTrue(is_clear_dental_value("2 x 5 years"))


class SiblingAndOverlayTests(unittest.TestCase):
    def test_sibling_fill_kb_shape(self):
        plans = [
            {
                "id": "H1019-150",
                "county": "Miami-Dade",
                "dentalWorking": [("Crowns", "2 every 5 years"), ("Bridges", "Yes")],
            },
            {"id": "H1019-150", "county": "Broward", "dentalWorking": []},
        ]
        n = apply_sibling_dental_fill(plans, fields_key="dentalWorking")
        self.assertGreaterEqual(n, 1)
        broward = plans[1]["dentalWorking"]
        labels = {lab: val for lab, val in broward}
        self.assertEqual(labels["Crowns"], "2 every 5 years")
        self.assertEqual(labels["Bridges"], "Yes")

    def test_curated_overlay(self):
        fields: list[tuple[str, str]] = [("Dental", "Comprehensive")]
        notes = apply_curated_dental("H1019-150", "Broward", fields)
        self.assertTrue(notes)
        labels = {lab: val for lab, val in fields}
        self.assertEqual(labels["Crowns"], "2 every 5 years")
        self.assertEqual(labels["Bridges"], "Yes")

    def test_plan_data_objects(self):
        plans = [
            {
                "id": "H1019-150",
                "planId": "H1019-150",
                "county": "Miami-Dade",
                "dentalCrowns": "2 every 5 years",
                "dentalBridges": "Yes",
            },
            {
                "id": "H1019-150",
                "planId": "H1019-150",
                "county": "Broward",
                "dentalCrowns": "$0\nvaries",
                "dentalBridges": "$0\nvaries",
            },
        ]
        apply_sibling_dental_on_plan_objects(plans)
        self.assertEqual(plans[1]["dentalCrowns"], "2 every 5 years")
        self.assertEqual(plans[1]["dentalBridges"], "Yes")
        apply_curated_on_plan_objects(plans)
        self.assertEqual(plans[1]["dentalCrowns"], "2 every 5 years")


if __name__ == "__main__":
    unittest.main()
