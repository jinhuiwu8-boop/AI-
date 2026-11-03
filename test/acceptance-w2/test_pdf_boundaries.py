"""Independent in-memory inspection of the production PDF renderer; no printer I/O."""
import io
import json
import subprocess
import sys
import unittest
from pathlib import Path

from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
RENDERER = ROOT / "tools/render_bill_pdf.py"
POINTS_PER_MM = 72 / 25.4


def order(count=1):
    rows = [{"lineId": f"line-{i}", "productName": f"合成商品{i + 1:02d}",
             "unit": "箱", "quantity": 1, "priceCents": 1234, "lineAmountCents": 1234}
            for i in range(count)]
    return {"id": "synthetic-a07-w2", "type": "SALE", "customerName": "合成核查客户",
            "createdAt": "2026-10-31T16:01:00Z", "revision": 1,
            "items": rows, "totals": {"goodsCents": 1234 * count,
                                      "receivableCents": 1234 * count}}


def render(snapshot, template=None):
    return subprocess.run([sys.executable, "-B", "-X", "utf8", str(RENDERER)],
                          input=json.dumps({"snapshot": snapshot, "template": template or {}},
                                           ensure_ascii=False).encode("utf-8"),
                          capture_output=True, timeout=20)


def amount_at(page, normalized_y):
    records = []
    target = 190 * POINTS_PER_MM * (1 - normalized_y / 1641)

    def visit(text, _cm, tm, _font, _size):
        value = text.strip()
        # Quantity shares the row baseline; inspect only the seven money cells.
        if value.isascii() and value.isdigit() and tm[4] >= 240 and abs(tm[5] - target) < 1:
            records.append((tm[4], value))

    page.extract_text(visitor_text=visit)
    return "".join(value for _, value in sorted(records))


class IndependentPdfBoundaries(unittest.TestCase):
    def reader(self, snapshot):
        result = render(snapshot)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        self.assertTrue(result.stdout.startswith(b"%PDF-"))
        return PdfReader(io.BytesIO(result.stdout))

    def test_dimensions_chinese_variables_and_no_fixed_background(self):
        pdf = self.reader(order())
        self.assertEqual(len(pdf.pages), 1)
        page = pdf.pages[0]
        self.assertAlmostEqual(float(page.mediabox.width), 130 * POINTS_PER_MM, places=3)
        self.assertAlmostEqual(float(page.mediabox.height), 190 * POINTS_PER_MM, places=3)
        text = page.extract_text()
        self.assertIn("合成核查客户", text)
        self.assertIn("合成商品01", text)
        self.assertIn("12.34", text)
        self.assertNotIn("文博", text)
        self.assertFalse(page["/Resources"].get("/XObject"), "Variable PDF unexpectedly embeds a background image")
        self.assertEqual(int(amount_at(page, 420)), 1234)

    def test_sixteen_items_paginate_and_whole_order_total_is_on_last_page_only(self):
        pdf = self.reader(order(16))
        self.assertEqual(len(pdf.pages), 2)
        texts = [page.extract_text() for page in pdf.pages]
        for i in range(16):
            self.assertEqual(sum(text.count(f"合成商品{i + 1:02d}") for text in texts), 1)
        self.assertEqual(amount_at(pdf.pages[0], 1400), "")
        self.assertEqual(int(amount_at(pdf.pages[1], 1400)), 1234 * 16)
        for page in pdf.pages:
            self.assertAlmostEqual(float(page.mediabox.width), 130 * POINTS_PER_MM, places=3)
            self.assertAlmostEqual(float(page.mediabox.height), 190 * POINTS_PER_MM, places=3)

    def test_seven_currency_cells_preserve_every_digit_at_supported_maximum(self):
        snapshot = order()
        snapshot["items"][0].update(priceCents=9_999_999, lineAmountCents=9_999_999)
        snapshot["totals"].update(goodsCents=9_999_999, receivableCents=9_999_999)
        page = self.reader(snapshot).pages[0]
        self.assertEqual(amount_at(page, 420), "9999999")
        self.assertEqual(amount_at(page, 1400), "9999999")

    def test_over_limit_unit_line_or_total_is_rejected_without_partial_pdf(self):
        for field in ("priceCents", "lineAmountCents", "receivableCents"):
            with self.subTest(field=field):
                snapshot = order()
                target = snapshot["totals"] if field == "receivableCents" else snapshot["items"][0]
                target[field] = 10_000_000
                result = render(snapshot)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, b"")

    def test_unsupported_type_extreme_name_and_calibration_offset_are_rejected(self):
        changed_type = order()
        changed_type["type"] = "RETURN"
        long_name = order()
        long_name["customerName"] = "合" * 500
        for snapshot, template in [(changed_type, {}), (long_name, {}), (order(), {"offsetXmm": 21})]:
            result = render(snapshot, template)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, b"")


if __name__ == "__main__":
    unittest.main()
