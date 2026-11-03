"""130x190mm variable layer for the supplied Wenbo paper; calibration is draft."""
import io
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.units import mm


def render(envelope):
    order = envelope['snapshot']
    template = envelope.get('template', {})
    rows = order['items']
    if order.get('type') != 'SALE' or not isinstance(rows, list) or not 1 <= len(rows) <= 100:
        raise ValueError('Only confirmed sales variable layers are supported')
    font_path = next((p for p in [Path('C:/Windows/Fonts/simsun.ttc'), Path('C:/Windows/Fonts/msyh.ttc')] if p.is_file()), None)
    if font_path is None:
        raise ValueError('A verified Chinese font must be configured')
    pdfmetrics.registerFont(TTFont('WenboChinese', str(font_path), subfontIndex=0))
    # Source-photo normalized coordinates are a review draft, never an assertion
    # that the physical iP110 feed has been calibrated.
    width, height = 130 * mm, 190 * mm
    output = io.BytesIO()
    pdf = canvas.Canvas(output, pagesize=(width, height), pageCompression=1)
    pdf.setTitle('Wenbo 130x190 variable layer - calibration draft')
    dx = float(template.get('offsetXmm', 0)) * mm
    dy = float(template.get('offsetYmm', 0)) * mm
    if abs(dx) > 20 * mm or abs(dy) > 20 * mm:
        raise ValueError('Calibration offset is outside the supported range')
    def px(x): return x / 1114 * width + dx
    def py(y): return height - y / 1641 * height - dy
    def fit(text, max_width, start=9, minimum=6, font='WenboChinese'):
        text = str(text)
        size = start
        while size >= minimum:
            if pdfmetrics.stringWidth(text, font, size) <= max_width:
                return text, size
            size -= .25
        raise ValueError('A field does not fit without losing content')
    def text(x, y, value, max_width, start=9, center=False, font='WenboChinese'):
        value, size = fit(value, max_width, start, font=font)
        pdf.setFont(font, size)
        if center: pdf.drawCentredString(px(x), py(y), value)
        else: pdf.drawString(px(x), py(y), value)
    def cents(value):
        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 9_999_999:
            raise ValueError('Amount exceeds the seven preprinted currency cells')
        return f'{value:07d}'
    def amount(y, value):
        digits = cents(value)
        positions = [766, 808, 849, 891, 933, 975, 1017]
        first = min(next((i for i, d in enumerate(digits) if d != '0'), 4), 4)
        for i, digit in enumerate(digits):
            if i >= first: text(positions[i], y, digit, 4.5 * mm, 10, center=True, font='Helvetica')
    stamp = datetime.fromisoformat(order['createdAt'].replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Shanghai'))
    pages = [rows[n:n+15] for n in range(0, len(rows), 15)]
    for page_number, page_rows in enumerate(pages):
        text(145, 292, order['customerName'], 72 * mm, 10)
        text(812, 292, stamp.strftime('%Y'), 9 * mm, 9, font='Helvetica')
        text(919, 292, stamp.strftime('%m'), 5 * mm, 9, font='Helvetica')
        text(996, 292, stamp.strftime('%d'), 5 * mm, 9, font='Helvetica')
        for index, item in enumerate(page_rows):
            y = 420 + 64.8 * index
            text(76, y, item['productName'], 35 * mm, 9)
            text(435, y, item['unit'], 8 * mm, 9, center=True)
            text(550, y, item['quantity'], 12 * mm, 10, center=True, font='Helvetica')
            price = item['priceCents']
            cents(price)
            text(681, y, f'{price // 100}.{price % 100:02d}', 13 * mm, 10, center=True, font='Helvetica')
            amount(y, item['lineAmountCents'])
        if page_number == len(pages) - 1:
            # Final payable is printed once; monetary adjustments remain fully
            # visible in the PNG. Their paper positions need separate approval.
            amount(1400, order['totals']['receivableCents'])
        pdf.showPage()
    pdf.save()
    return output.getvalue()


if __name__ == '__main__':
    sys.stdout.buffer.write(render(json.load(sys.stdin)))
