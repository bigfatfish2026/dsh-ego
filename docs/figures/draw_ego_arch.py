#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh / RSI 系统架构图（README 里的图 A）。

画什么：QQ 传输 → 主会话路由 → dsh-dispatcher（ticket desk + 只追加的 ticket log）
→ minnow 子代理池，底下 dsh-memory，右边 dsh-ego 里套着 proposer（stage1 候选 →
stage2 plan）与 adjudicator（1 gate → 2 veto → 3 arbiter → 4 judge）；三种线型分开
主线 / ego 提案 / 工单与回报。

跑法：
    python3 docs/figures/draw_ego_arch.py --out docs/img --scale 0.88
    python3 docs/figures/draw_ego_arch.py --out /tmp/fig

产物（默认写在 --out 里，名字由 BASE 决定）：
    ego-arch.svg  -- 矢量母版，改图改这个
    ego-arch.png  -- 栅格导出，宽度 = 1810 * --scale

--data 可选：一份 JSON，只认 {"title": ..., "desc": ...} 两个键，用来换掉 SVG 里
<title>/<desc> 的无障碍描述，不改图面文字。
"""

import argparse
import json
from pathlib import Path

import cairosvg

# ---------------------------------------------------------------------
# Canvas and visual system
# ---------------------------------------------------------------------
W, H = 1810, 1190


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="重画 dsh-ego 架构图（ego-arch.png/.svg）")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent),
                    help="产物目录，默认脚本所在目录")
    ap.add_argument("--scale", type=float, default=2.0,
                    help="PNG 相对画布的缩放倍数，默认 2（宽 3620）；README 用 0.88（宽约 1593）")
    ap.add_argument("--data", default=None,
                    help="可选 JSON，覆盖 SVG 的 title / desc")
    return ap.parse_args(argv)


ARGS = parse_args()
OUT = Path(ARGS.out).expanduser().resolve()
OUT.mkdir(parents=True, exist_ok=True)
BASE = OUT / "ego-arch"
SCALE = ARGS.scale

TITLE = "Distributed agent architecture with RSI components"
DESC = ("QQ transport, router session, ticket dispatcher, minnow worker pool, "
        "long-term memory, and an ego module containing a bottom-up proposer "
        "and adjudicator.")
if ARGS.data:
    _over = json.loads(Path(ARGS.data).expanduser().read_text(encoding="utf-8"))
    TITLE = _over.get("title", TITLE)
    DESC = _over.get("desc", DESC)

C = {
    "ink":       "#253247",
    "muted":     "#66758A",
    "border":    "#D5DDE7",
    "border2":   "#C7D1DE",
    "panel":     "#F4F6F9",
    "white":     "#FFFFFF",
    "blue":      "#4778A8",
    "blue_fill": "#EEF4FA",
    "amber":     "#A9773F",
    "amber_fill":"#FBF5EC",
    "green":     "#568267",
    "green_fill":"#EEF5F0",
    "purple":    "#7656A5",
    "rule":      "#A7B2C1",
}

FONT = "Arial, Helvetica, 'Liberation Sans', 'DejaVu Sans', sans-serif"

# Type sizes are deliberately larger than the supplied v6 figure so that
# labels remain legible after reduction to a typical two-column figure width.
FS = {
    "module": 27,
    "section": 23,
    "node": 21,
    "note": 18,
    "edge": 16,
    "micro": 16,
}

shapes = []
edges = []
texts = []


def esc(value: str) -> str:
    return (value.replace("&", "&amp;")
                 .replace("<", "&lt;")
                 .replace(">", "&gt;"))


def rect(x, y, w, h, fill, stroke=None, sw=1.35, r=12):
    stroke = stroke or C["border"]
    shapes.append(
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" '
        f'rx="{r}" ry="{r}" fill="{fill}" stroke="{stroke}" '
        f'stroke-width="{sw}"/>'
    )


def txt(x, y, value, size=None, color=None, anchor="middle", weight=400,
        halo=False, letter_spacing=None):
    size = size or FS["node"]
    color = color or C["ink"]
    ls = f' letter-spacing="{letter_spacing}"' if letter_spacing else ""
    body = (
        f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" '
        f'font-weight="{weight}" fill="{color}" text-anchor="{anchor}"{ls}>'
        f'{esc(value)}</text>'
    )
    if halo:
        outlined = body.replace(
            f'fill="{color}"',
            'fill="none" stroke="#FFFFFF" stroke-width="5" '
            'stroke-linejoin="round" paint-order="stroke"'
        )
        texts.append(outlined)
    texts.append(body)


def module(x, y, w, h, title, subtitle, accent=None, fill=None):
    rect(x, y, w, h, fill or C["panel"], C["border"], 1.5, 15)
    if accent:
        # A restrained header rule provides consistent grouping without
        # introducing decorative gradients, shadows, or pictograms.
        shapes.append(
            f'<path d="M {x+16} {y+15} H {x+w-16}" stroke="{accent}" '
            f'stroke-width="3.2" stroke-linecap="round"/>'
        )
    txt(x + 22, y + 51, title, FS["module"], C["ink"], "start", 700)
    if subtitle:
        txt(x + 22, y + 75, subtitle, FS["note"], C["muted"], "start")


_FONT_FILE = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
_font_cache = {}


def text_width(value, size):
    """Advance width of the bold face, so mixed sizes can be centred as one."""
    from PIL import ImageFont
    if not Path(_FONT_FILE).exists():
        return len(value) * size * 0.56
    key = size
    if key not in _font_cache:
        _font_cache[key] = ImageFont.truetype(_FONT_FILE, size)
    return _font_cache[key].getlength(value)


def numline(x, y, num, title, size, num_size=18):
    """One line, number + title, centred as a whole on the card axis.

    The number shares the title baseline, sits one step smaller in the muted
    colour, and keeps a fixed gap, so the pair reads as a single centred line.
    """
    gap = round(size * 0.34, 1)
    wn = text_width(num, num_size)
    wt = text_width(title, size)
    left = round(x - (wn + gap + wt) / 2, 1)
    txt(left, y, num, num_size, C["muted"], "start", 600)
    txt(round(left + wn + gap, 1), y, title, size, C["ink"], "start", 600)


def card(x, y, w, h, title, note=None, fill=None, stroke=None,
         title_size=None, note_size=None, num=None):
    rect(x, y, w, h, fill or C["white"], stroke or C["border"], 1.15, 8)
    cx = x + w / 2
    if note:
        if num:
            numline(cx, y + h / 2 - 3, num, title, title_size or FS["node"])
        else:
            txt(cx, y + h / 2 - 3, title, title_size or FS["node"], C["ink"],
                weight=600)
        txt(cx, y + h / 2 + 18, note, note_size or FS["micro"], C["muted"])
    else:
        if num:
            numline(cx, y + h / 2 + 7, num, title, title_size or FS["node"])
        else:
            txt(cx, y + h / 2 + 7, title, title_size or FS["node"], C["ink"],
                weight=600)


def rounded_path(points, radius=10):
    """Build an orthogonal path with small rounded corners."""
    if len(points) < 2:
        raise ValueError("A path needs at least two points")
    d = f"M {points[0][0]} {points[0][1]}"
    for i in range(1, len(points) - 1):
        x0, y0 = points[i - 1]
        x1, y1 = points[i]
        x2, y2 = points[i + 1]
        dx1, dy1 = x1 - x0, y1 - y0
        dx2, dy2 = x2 - x1, y2 - y1
        l1 = max(abs(dx1), abs(dy1))
        l2 = max(abs(dx2), abs(dy2))
        if not l1 or not l2:
            d += f" L {x1} {y1}"
            continue
        rr = min(radius, l1 / 2, l2 / 2)
        ax, ay = x1 - (dx1 / l1) * rr, y1 - (dy1 / l1) * rr
        bx, by = x1 + (dx2 / l2) * rr, y1 + (dy2 / l2) * rr
        d += f" L {ax:.1f} {ay:.1f} Q {x1} {y1} {bx:.1f} {by:.1f}"
    d += f" L {points[-1][0]} {points[-1][1]}"
    return d


EDGE_STYLE = {
    "main": {"stroke": C["ink"], "width": 1.7, "dash": "", "marker": "arrow-ink"},
    "thin": {"stroke": C["muted"], "width": 1.35, "dash": "", "marker": "arrow-muted"},
    "dash": {"stroke": C["muted"], "width": 1.6, "dash": ' stroke-dasharray="7 6"', "marker": "arrow-muted"},
    "idea": {"stroke": C["blue"], "width": 2.0, "dash": ' stroke-dasharray="8 6"', "marker": "arrow-blue"},
    "work": {"stroke": C["purple"], "width": 2.6, "dash": "", "marker": "arrow-purple"},
}


def edge(points, kind="main", label=None, label_at=None, anchor="middle",
         label_color=None, label_size=None):
    s = EDGE_STYLE[kind]
    edges.append(
        f'<path d="{rounded_path(points)}" fill="none" stroke="{s["stroke"]}" '
        f'stroke-width="{s["width"]}"{s["dash"]} stroke-linecap="round" '
        f'stroke-linejoin="round" marker-end="url(#{s["marker"]})"/>'
    )
    if label and label_at:
        txt(label_at[0], label_at[1], label, label_size or FS["edge"],
            label_color or s["stroke"], anchor, 600, halo=True)


# ---------------------------------------------------------------------
# Main modules: aligned on a four-column grid
# ---------------------------------------------------------------------
# Column 1: QQ transport and legend
module(60, 110, 260, 190, "im-qqbot", "QQ transport in / out")

# Column 2: router and memory
module(420, 90, 340, 230, "router agent",
       "wires tools, dispatches work")
module(420, 510, 340, 190, "dsh-memory", "long-term recall",
       accent=C["green"], fill=C["green_fill"])

# Column 3: dispatcher and ego
module(860, 90, 530, 270, "dsh-dispatcher",
       "executor: opens, dispatches, closes tickets",
       accent=C["purple"])
# Ticket desk and append-only log are distinct subcomponents.
card(882, 180, 318, 142, "ticket desk", "single writer of tickets",
     title_size=22, note_size=16)
card(1218, 180, 150, 142, "ticket log", "append-only record",
     title_size=20, note_size=16)

# Column 4: worker pool
module(1490, 110, 260, 250, "minnow pool", "")
card(1510, 175, 220, 58, "minnow (subagent)", "runs one ticket",
     title_size=18, note_size=16)
card(1510, 248, 220, 44, "minnow", title_size=18)
card(1510, 305, 220, 44, "minnow", title_size=18)

# Lower-left legend
rect(60, 520, 260, 190, C["white"], C["border"], 1.35, 12)
txt(82, 557, "legend", FS["section"], C["ink"], "start", 700)

# Lower-middle memory module is above; ego occupies column 3.
rect(860, 465, 530, 670, C["white"], C["border2"], 1.65, 15)
txt(884, 505, "dsh-ego", FS["module"], C["ink"], "start", 700)
txt(884, 529, "finds its own work", FS["note"], C["muted"], "start")

# Adjudicator: the checks are intentionally ordered bottom-up.
rect(882, 550, 486, 280, C["amber_fill"], "#E8D8C5", 1.25, 12)
txt(902, 581, "adjudicator", FS["section"], C["ink"], "start", 700)
txt(902, 603, "four serial checks", FS["note"], C["muted"], "start")
card(922, 615, 426, 44, "judge", "worth doing? four verdicts", title_size=19, note_size=16, num="4")
card(922, 669, 426, 44, "arbiter", "unsure items escalated by gate", title_size=19, note_size=16, num="3")
card(922, 723, 426, 44, "veto", "owner already killed this?", title_size=19, note_size=16, num="2")
card(922, 777, 426, 44, "gate", "syntax & structure gates", title_size=19, note_size=16, num="1")

# Proposer: read/action cells -> stage 1 -> stage 2, flowing upward.
rect(882, 860, 486, 255, C["blue_fill"], "#D4E0ED", 1.25, 12)
txt(902, 891, "proposer", FS["section"], C["ink"], "start", 700)
txt(902, 913, "candidates then plan", FS["note"], C["muted"], "start")
card(922, 926, 426, 42, "stage2 plan", "one model call", title_size=19, note_size=16)
card(922, 982, 426, 42, "stage1 candidates", "grid pairs, no model call", title_size=19, note_size=16)
card(922, 1038, 205, 48, "read cells", "what ego can read", title_size=18, note_size=16)
card(1143, 1038, 205, 48, "action cells", "what ego can do", title_size=18, note_size=16)
txt(1135, 1067, "‖", 22, C["muted"], weight=500)
txt(1135, 1104, "pair read × action cells", FS["micro"], C["muted"])

# ---------------------------------------------------------------------
# Connectors. These are routed through whitespace between the grid cells.
# ---------------------------------------------------------------------
# QQ <-> main-session
edge([(320, 170), (420, 170)], "main", "inbound: agent.followup",
     (370, 153), label_size=15)
edge([(420, 245), (320, 245)], "dash", "session/event + assistant stream",
     (370, 268), label_size=15)

# Main-session <-> dispatcher (steps 1 and 5)
edge([(760, 180), (860, 180)], "work", "1 dispatch_open", (810, 160),
     label_size=15)
edge([(760, 270), (860, 270)], "work", "5 dispatch_close", (810, 292),
     label_size=15)

# Dispatcher <-> minnow pool (steps 2 and 3)
edge([(1390, 180), (1490, 180)], "work", "2 spawn", (1440, 160),
     label_size=15)
edge([(1490, 275), (1390, 275)], "work", "3 dispatch_report", (1440, 299),
     label_size=15)

# Step 4: ticket desk sends a report to the main session.
edge([(1040, 360), (1040, 405), (700, 405), (700, 320)], "work",
     "4 send_message", (865, 396), label_size=15)

# Main-session -> memory: save/archive and merge/reflect.
edge([(470, 320), (470, 510)], "main")
txt(490, 376, "memory_save · archive", FS["edge"], C["muted"], "start", 600,
    halo=True)
txt(490, 397, "merge · reflect", FS["edge"], C["muted"], "start", 600,
    halo=True)

# Minnow pool -> memory: read-only; writes are blocked.
edge([(1620, 360), (1620, 420), (800, 420), (800, 565), (760, 565)],
     "dash", "read only, write blocked", (1175, 405), label_size=15)

# Ego -> main-session: asks for a ticket, never touches the ticket desk.
edge([(860, 820), (370, 820), (370, 280), (420, 280)], "idea",
     "ticket request (agent.followup)", (610, 802), label_size=15)

# Ego -> memory: read only.
edge([(860, 660), (760, 660)], "idea", "read only", (810, 642),
     label_size=15)

# Ego internals: bottom-up flow, proposer -> adjudicator.
edge([(1125, 860), (1125, 830)], "main")
# Gate -> veto -> arbiter -> judge.
edge([(922, 799), (905, 799), (905, 745), (922, 745)], "main")
edge([(922, 745), (905, 745), (905, 691), (922, 691)], "main")
edge([(922, 691), (905, 691), (905, 637), (922, 637)], "main")
# Proposer: read/action cells -> stage 1 -> stage 2.
edge([(1000, 1038), (1000, 1024)], "main")
edge([(1270, 1038), (1270, 1024)], "main")
edge([(922, 1003), (905, 1003), (905, 947), (922, 947)], "main")

# ---------------------------------------------------------------------
# Legend swatches
# ---------------------------------------------------------------------
for y, kind, label in (
    (590, "main", "main flow"),
    (635, "idea", "ego proposal"),
    (680, "work", "work & report"),
):
    st = EDGE_STYLE[kind]
    edges.append(
        f'<path d="M 84 {y} H 148" fill="none" stroke="{st["stroke"]}" '
        f'stroke-width="{st["width"]}"{st["dash"]} '
        f'marker-end="url(#{st["marker"]})"/>'
    )
    txt(168, y + 5, label, FS["note"], C["muted"], "start")

# ---------------------------------------------------------------------
# SVG assembly and export
# ---------------------------------------------------------------------
svg_header = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}"
 viewBox="0 0 {W} {H}" role="img" aria-labelledby="fig-title fig-desc">
<title id="fig-title">{TITLE}</title>
<desc id="fig-desc">{DESC}</desc>
<defs>
  <marker id="arrow-ink" viewBox="0 0 10 10" refX="9.1" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M 0.6 1.2 L 9.2 5 L 0.6 8.8 z" fill="{C['ink']}"/>
  </marker>
  <marker id="arrow-muted" viewBox="0 0 10 10" refX="9.1" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M 0.6 1.2 L 9.2 5 L 0.6 8.8 z" fill="{C['muted']}"/>
  </marker>
  <marker id="arrow-blue" viewBox="0 0 10 10" refX="9.1" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M 0.6 1.2 L 9.2 5 L 0.6 8.8 z" fill="{C['blue']}"/>
  </marker>
  <marker id="arrow-purple" viewBox="0 0 10 10" refX="9.1" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto">
    <path d="M 0.6 1.2 L 9.2 5 L 0.6 8.8 z" fill="{C['purple']}"/>
  </marker>
</defs>
<rect x="0" y="0" width="{W}" height="{H}" fill="#FFFFFF"/>
'''

svg = svg_header + "\n".join(shapes + edges + texts) + "\n</svg>\n"
svg_path = BASE.with_suffix(".svg")
png_path = BASE.with_suffix(".png")
svg_path.write_text(svg, encoding="utf-8")
png_w, png_h = round(W * SCALE), round(H * SCALE)
cairosvg.svg2png(
    bytestring=svg.encode("utf-8"),
    write_to=str(png_path),
    output_width=png_w,
    output_height=png_h,
    background_color="#FFFFFF",
)
print(f"Wrote {svg_path}")
print(f"Wrote {png_path} ({png_w} x {png_h})")
