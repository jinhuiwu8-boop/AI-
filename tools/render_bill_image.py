"""Render a frozen local order to PNG on stdout; no business writes."""
import io
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from PIL import Image, ImageDraw, ImageFont


def main():
    order = json.load(sys.stdin)
    items = order.get('items', [])
    if not isinstance(items, list) or not 1 <= len(items) <= 100:
        raise ValueError('Document must contain 1 to 100 items')
    font_path = next((p for p in [Path('C:/Windows/Fonts/msyh.ttc'), Path('C:/Windows/Fonts/simsun.ttc'), Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')] if p.is_file()), None)
    if font_path is None:
        raise RuntimeError('No document font is available')
    font = lambda size: ImageFont.truetype(str(font_path), size)
    img = Image.new('RGB', (1000, 480 + len(items) * 66), '#ffffff')
    draw = ImageDraw.Draw(img)
    ink = '#173d35'
    def label(x, y, text, size=24, fill=ink):
        draw.text((x, y), str(text), font=font(size), fill=fill)
    def money(cents):
        if not isinstance(cents, int) or isinstance(cents, bool):
            raise ValueError('Amounts must be integer cents')
        return f'{cents // 100}.{cents % 100:02d}' if cents >= 0 else '-' + money(-cents)
    def fit(text, width, size=23):
        text = str(text)
        for n in range(size, 13, -1):
            if draw.textlength(text, font=font(n)) <= width:
                return text, n
        raise ValueError('Document field cannot fit without losing content')
    def bounded(x, y, text, width, size=23, fill=ink):
        fitted, actual_size = fit(text, width, size)
        label(x, y, fitted, actual_size, fill)
    is_return = order.get('type') == 'RETURN'
    label(40, 28, '退货单' if is_return else '销售清单', 38)
    bounded(40, 84, f"客户：{order.get('customerName', '')}", 920, 25)
    stamp = order.get('createdAt', '')
    if stamp:
        stamp = datetime.fromisoformat(stamp.replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Shanghai')).strftime('%Y-%m-%d %H:%M')
    label(40, 126, f'日期：{stamp}', 22)
    label(40, 160, f"单号：{order.get('id', '')} / v{order.get('revision', 1)}", 17, '#5c706a')
    if is_return:
        if order.get('returnBasis') == 'CUSTOMER_HISTORY':
            label(40, 188, '按客户历史开单价退货 · 散瓶按历史箱价拆算到角', 17, '#8c502d')
        else:
            label(40, 188, f"原销售单：{order.get('sourceOrderId', '')}", 17, '#8c502d')
    xs = [40, 480, 570, 665, 820]
    draw.rounded_rectangle((32, 224, 968, 270), radius=6, fill='#e7f1ec')
    for x, text in zip(xs, ['产品名称', '单位', '数量', '单价', '金额']):
        label(x, 234, text, 22)
    y = 285
    for item in items:
        name, size = fit(item.get('productName', item.get('skuId', '')), 420)
        label(xs[0], y, name, size)
        for x, width, text in zip(xs[1:], [70, 75, 135, 140], [item['unit'], item['quantity'], money(item['priceCents']), money(item['lineAmountCents'])]):
            bounded(x, y, text, width, 23)
        if item['priceCents'] == 0:
            label(xs[0], y + 29, '零价 · 不影响以后售价', 15, '#8c502d')
        draw.line((40, y + 53, 960, y + 53), fill='#dbe6e1', width=1)
        y += 66
    totals = order['totals']
    bounded(40, y + 8, f"货款：¥{money(totals['goodsCents'])}", 920, 23)
    bounded(40, y + 46, f"抵扣：¥{money(totals.get('creditCents', 0))}", 430, 21)
    bounded(500, y + 46, f"抹零：¥{money(totals.get('waiverCents', 0))}", 430, 21)
    bounded(40, y + 91, ('退货合计' if is_return else '合计应收') + f"：¥{money(totals['receivableCents'])}", 920, 31)
    label(40, y + 150, '本地开发版 · 合成样例请勿作为实际交易凭证', 17, '#71837b')
    out = io.BytesIO()
    img.save(out, format='PNG')
    sys.stdout.buffer.write(out.getvalue())


if __name__ == '__main__':
    main()
