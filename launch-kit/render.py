from playwright.sync_api import sync_playwright
import pathlib, base64
here = pathlib.Path(__file__).parent.resolve()
A = base64.b64encode((here / "Archivo.woff2").read_bytes()).decode()
ORANGE, INK, PAPER = "#e8501c", "#12161c", "#eef0f2"


def mark(line="#ffffff"):
    return f'''<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2 4.5 H22" fill="none" stroke="{ORANGE}" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 2.6"/><path d="M2.5 20 L7.5 14 L11 16.5 L17 7.5" fill="none" stroke="{line}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="18" cy="5" r="3.4" fill="{ORANGE}"/></svg>'''


base = f'''<style>@font-face{{font-family:A;src:url(data:font/woff2;base64,{A}) format("woff2");font-weight:100 900;font-stretch:62% 125%}}
html,body{{margin:0}} .d{{font-family:A;font-weight:900;font-stretch:122%;letter-spacing:-0.04em}} .b{{font-family:A;font-weight:500}}</style>'''


def chart(w, h, sold_label=True):
    # Price line rising to a dashed target line, sold at the hit.
    pts = [(0.0, 0.78), (0.08, 0.74), (0.15, 0.82), (0.23, 0.68), (0.3, 0.72), (0.38, 0.58), (0.46, 0.64), (0.54, 0.5), (0.61, 0.54), (0.69, 0.4), (0.76, 0.45), (0.84, 0.32), (0.9, 0.35), (0.96, 0.22)]
    d = "M" + " L".join(f"{x * w:.1f} {y * h:.1f}" for x, y in pts)
    tx, ty = 0.96 * w, 0.22 * h
    tag = f'<rect x="{tx - 44}" y="{ty + 18}" width="88" height="34" rx="17" fill="{ORANGE}"/><text x="{tx}" y="{ty + 41}" text-anchor="middle" font-family="A" font-weight="800" font-size="18" fill="#fff">Sold</text>' if sold_label else ""
    return f'''<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg" style="overflow:visible">
<line x1="0" y1="{0.78 * h}" x2="{w}" y2="{0.78 * h}" stroke="rgba(255,255,255,.25)" stroke-dasharray="2 6" stroke-width="2"/>
<line x1="0" y1="{ty}" x2="{w}" y2="{ty}" stroke="{ORANGE}" stroke-dasharray="12 10" stroke-width="3"/>
<text x="0" y="{ty - 14}" font-family="A" font-weight="800" font-size="20" fill="{ORANGE}">Your target +25%</text>
<path d="{d}" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="{tx}" cy="{ty}" r="10" fill="{ORANGE}"/>{tag}</svg>'''


logo = base + f'<div style="width:1000px;height:1000px;display:grid;place-items:center;background:{INK}"><div style="width:620px;height:620px">{mark()}</div></div>'

header = base + f'''<div style="width:1500px;height:500px;position:relative;overflow:hidden;background:{INK};color:#fff">
<div style="position:absolute;left:410px;top:128px">
<div class="d" style="font-size:78px;line-height:1">Takestock</div>
<div class="b" style="font-size:32px;color:#c3c8d0;margin-top:20px;line-height:1.3">Set your gain on any Stock Token.<br>It sells when it hits.</div></div>
<div style="position:absolute;right:90px;top:120px">{chart(340, 250)}</div></div>'''

og = base + f'''<div style="width:1200px;height:630px;position:relative;overflow:hidden;background:{INK};color:#fff">
<div style="position:absolute;left:72px;top:64px;display:flex;align-items:center;gap:16px"><div style="width:52px;height:52px">{mark()}</div><div class="d" style="font-size:42px">Takestock</div></div>
<div class="d" style="position:absolute;left:72px;top:176px;width:600px;font-size:76px;line-height:0.96">Set your gain. Get paid when it hits.</div>
<div class="b" style="position:absolute;left:72px;bottom:60px;font-size:24px;color:#8a93a0">Take profit · Stop-loss · Ladders · Robinhood Chain</div>
<div style="position:absolute;right:80px;top:190px">{chart(380, 300)}</div></div>'''

with sync_playwright() as p:
    b = p.chromium.launch()
    for name, html, w, h in [("takestock-logo.png", logo, 1000, 1000), ("takestock-x-header.png", header, 1500, 500), ("og.png", og, 1200, 630)]:
        pg = b.new_page(viewport={"width": w, "height": h})
        pg.set_content(html)
        pg.wait_for_timeout(500)
        pg.screenshot(path=str(here / name))
    b.close()
