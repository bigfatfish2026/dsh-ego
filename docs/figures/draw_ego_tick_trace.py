#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一拍轨迹图（README 里的图 B）：一次真实 tick 从想法到归档。

画什么：三段横带。
  01 想法生成   —— 05:17:55 stage1 枚举出 9 个合法组合，选中 inspect files → delete files
  02 提议器 × 裁决器迭代 —— v1/v2/v3 三轮 plan，每轮被 gate 打回后转 arbiter 复核
  03 执行器     —— 排队问话、维护者回应、手工开票、备份校验删除、状态收尾

数据从哪来：**不读日志**。全部文案在 examples/tick.json 里，脱敏后的一份真实样本
（真票号保留，会话 id 与人称换占位）。要画成假数据或别的一拍，照那份 JSON 的
结构改一份，用 --data 指过去就行。

跑法：
    python3 docs/figures/draw_ego_tick_trace.py --out docs/img --scale 0.6
    python3 docs/figures/draw_ego_tick_trace.py --data /tmp/my-tick.json --out /tmp/fig

产物（默认写在 --out 里，名字由 BASE 决定）：
    ego-tick-trace.svg  -- 矢量母版
    ego-tick-trace.png  -- 栅格导出，宽度 = 2600 * --scale
"""

import argparse
import json
from pathlib import Path

import cairosvg

HERE = Path(__file__).resolve().parent
DEFAULT_DATA = HERE / "examples" / "tick.json"

W, H = 2600, 2680

C = {
    "ink": "#253247", "muted": "#66758A", "border": "#D5DDE7",
    "panel": "#F4F6F9", "white": "#FFFFFF",
    "blue": "#4778A8", "blue_fill": "#EEF4FA",
    "amber": "#A9773F", "amber_fill": "#FBF5EC",
    "green": "#568267", "green_fill": "#EEF5F0",
    "purple": "#7656A5", "purple_fill": "#F4F0FA",
    "quiet_fill": "#F4F6F9", "quiet_line": "#C4CFDD",
}
FONT = "'Noto Sans CJK SC', 'Noto Sans CJK JP', Arial, Helvetica, sans-serif"
FS = {"section": 29, "subtitle": 18, "title": 23, "body": 21,
      "body_small": 19, "edge": 17}

# style name in the data file -> (accent stroke, card fill)
STYLE = {
    "blue": (C["blue"], C["blue_fill"]),
    "amber": (C["amber"], C["amber_fill"]),
    "green": (C["green"], C["green_fill"]),
    "purple": (C["purple"], C["purple_fill"]),
    "quiet": (C["quiet_line"], C["quiet_fill"]),
}

panels, node_shapes, paths, texts, edge_labels = [], [], [], [], []


def esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def rect(target, x, y, w, h, fill, stroke=None, sw=1.45, r=12):
    stroke = stroke or C["border"]
    target.append(
        f'<rect x="{x}" y="{y}" width="{w}" height="{h}" '
        f'rx="{r}" ry="{r}" fill="{fill}" stroke="{stroke}" '
        f'stroke-width="{sw}"/>'
    )


def svg_line(target, x1, y1, x2, y2, stroke, sw=3, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    target.append(
        f'<path d="M {x1} {y1} L {x2} {y2}" fill="none" '
        f'stroke="{stroke}" stroke-width="{sw}"{d} '
        f'stroke-linecap="round"/>'
    )


def text(x, y, value, size, color=None, anchor="start", weight=400):
    color = color or C["ink"]
    texts.append(
        f'<text x="{x}" y="{y}" font-family="{FONT}" '
        f'font-size="{size}" font-weight="{weight}" fill="{color}" '
        f'text-anchor="{anchor}">{esc(value)}</text>'
    )


def section(x, y, w, h, number, title, subtitle, accent, gap_at=None):
    rect(panels, x, y, w, h, C["panel"], C["border"], 1.5, 15)
    if gap_at is None:
        svg_line(panels, x + 22, y + 18, x + w - 22, y + 18, accent, 3.4)
    else:
        svg_line(panels, x + 22, y + 18, gap_at - 28, y + 18, accent, 3.4)
        svg_line(panels, gap_at + 28, y + 18, x + w - 22, y + 18, accent, 3.4)
    text(x + 28, y + 64, f"{number}  {title}", FS["section"], C["ink"], weight=700)
    if subtitle:
        text(x + 29, y + 94, subtitle, FS["subtitle"], C["muted"])


def card(x, y, w, h, title, body, accent, fill, *,
         body_size=None, title_size=None, line_gap=27, valign="top"):
    """Flat node card; optional vertical centering for the execution row."""
    rect(node_shapes, x, y, w, h, fill, C["border"], 1.3, 9)
    svg_line(node_shapes, x + 16, y + 11, x + w - 16, y + 11, accent, 3.2)
    ts = title_size or FS["title"]
    bs = body_size or FS["body"]
    left = x + 24
    if valign == "middle":
        total = 29 + 12 + max(0, len(body)) * line_gap
        start = y + max(20, (h - total) / 2)
        title_y = start + 24
        body_y = title_y + 39
    else:
        title_y = y + 43
        body_y = y + 78
    text(left, title_y, title, ts, C["ink"], weight=700)
    for i, ln in enumerate(body):
        text(left, body_y + i * line_gap, ln, bs, C["muted"])


def rounded_path(points, radius=9):
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
        ax, ay = x1 - dx1 / l1 * rr, y1 - dy1 / l1 * rr
        bx, by = x1 + dx2 / l2 * rr, y1 + dy2 / l2 * rr
        d += f" L {ax:.1f} {ay:.1f} Q {x1} {y1} {bx:.1f} {by:.1f}"
    d += f" L {points[-1][0]} {points[-1][1]}"
    return d


EDGE = {
    "main": (C["ink"], 2.2, "", "arrow-ink"),
    "idea": (C["blue"], 2.5, ' stroke-dasharray="9 7"', "arrow-blue"),
    "work": (C["purple"], 2.8, "", "arrow-purple"),
    "quiet": (C["muted"], 2.0, ' stroke-dasharray="6 5"', "arrow-muted"),
}


def arrow(points, kind="main", label=None, label_at=None, anchor="middle"):
    stroke, sw, dash, marker = EDGE[kind]
    paths.append(
        f'<path d="{rounded_path(points)}" fill="none" stroke="{stroke}" '
        f'stroke-width="{sw}"{dash} stroke-linecap="round" '
        f'stroke-linejoin="round" marker-end="url(#{marker})"/>'
    )
    if label and label_at:
        edge_labels.append((label_at[0], label_at[1], label, stroke, anchor))


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="重画 dsh-ego 一拍轨迹图（ego-tick-trace.png/.svg）")
    ap.add_argument("--out", default=str(HERE), help="产物目录，默认脚本所在目录")
    ap.add_argument("--scale", type=float, default=2.0,
                    help="PNG 相对画布的缩放倍数，默认 2（宽 5200）；README 用 0.6（宽 1560）")
    ap.add_argument("--data", default=str(DEFAULT_DATA),
                    help="这一拍的文案数据（默认 examples/tick.json）")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    data = json.loads(Path(args.data).expanduser().read_text(encoding="utf-8"))
    out = Path(args.out).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)
    base = out / "ego-tick-trace"
    canvas = data.get("canvas", {})
    width, height = canvas.get("w", W), canvas.get("h", H)
    labels = data.get("labels", {})

    for s in data["sections"]:
        accent, _ = STYLE[s.get("style", "blue")]
        section(s["x"], s["y"], s["w"], s["h"], s["number"], s["title"],
                s.get("subtitle", ""), accent, s.get("gap_at"))

    row = data.get("row", {})
    row_y, row_h, node_w, gap = row.get("y", 2260), row.get("h", 300), row.get("node_w", 432), row.get("gap", 30)
    row_x = [120 + i * (node_w + gap) for i in range(row.get("count", 5))]

    for c in data["cards"]:
        accent, fill = STYLE[c.get("style", "quiet")]
        x = c["x"] if "x" in c else row_x[c["slot"]]
        card(x, c["y"], c["w"], c["h"], c["title"], c.get("body", []),
             accent, fill, body_size=c.get("body_size"),
             title_size=c.get("title_size"), line_gap=c.get("line_gap", 27),
             valign=c.get("valign", "top"))

    # Flow connectors. Dashed blue loops are proposal rewrites / resubmissions.
    arrow([(820, 297), (850, 297), (850, 682), (820, 682)], "idea")
    arrow([(820, 682), (860, 682), (860, 657), (900, 657)], "main")
    arrow([(1650, 730), (1650, 770)], "main")
    arrow([(1650, 990), (1650, 1010), (90, 1010), (90, 1122.5), (120, 1122.5)],
          "idea", labels.get("rewrite", ""), (850, 995))
    arrow([(820, 1122.5), (860, 1122.5), (860, 1100), (900, 1100)], "main")
    arrow([(1650, 1170), (1650, 1190)], "main")
    arrow([(1650, 1410), (1650, 1440), (90, 1440), (90, 1575), (120, 1575)],
          "idea", labels.get("rewrite", ""), (850, 1425))
    arrow([(820, 1575), (900, 1572.5)], "main")
    arrow([(1650, 1680), (1650, 1702), (1260, 1702), (1260, 1725)], "main")
    arrow([(1260, 1885), (1260, 2070)], "work")
    arrow([(1260, 2220), (1260, 2240), (336, 2240), (336, 2260)],
          "quiet", labels.get("reply", ""), (800, 2225))

    cy = row_y + row_h / 2
    for i in range(4):
        arrow([(row_x[i] + node_w, cy), (row_x[i + 1], cy)], "work" if i >= 2 else "main")

    meta = data.get("meta", {})
    header = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}"
 viewBox="0 0 {width} {height}" role="img" aria-labelledby="fig-title fig-desc">
<title id="fig-title">{esc(meta.get("title", "ego tick trace"))}</title>
<desc id="fig-desc">{esc(meta.get("desc", ""))}</desc>
<defs>
  <marker id="arrow-ink" viewBox="0 0 10 10" refX="9.1" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M 0.6 1.2 L 9.2 5 L 0.6 8.8 z" fill="{C['ink']}"/>
  </marker>
  <marker id="arrow-blue" viewBox="0 0 10 10" refX="9.1" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M 0.6 1.2 L 9.2 5 L 0.6 8.8 z" fill="{C['blue']}"/>
  </marker>
  <marker id="arrow-purple" viewBox="0 0 10 10" refX="9.1" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto">
    <path d="M 0.6 1.2 L 9.2 5 L 0.6 8.8 z" fill="{C['purple']}"/>
  </marker>
  <marker id="arrow-muted" viewBox="0 0 10 10" refX="9.1" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M 0.6 1.2 L 9.2 5 L 0.6 8.8 z" fill="{C['muted']}"/>
  </marker>
</defs>
<rect x="0" y="0" width="{width}" height="{height}" fill="#FFFFFF"/>
'''

    label_svg = []
    for x, y, value, color, anchor in edge_labels:
        label_svg.append(
            f'<text x="{x}" y="{y}" font-family="{FONT}" '
            f'font-size="{FS["edge"]}" font-weight="600" fill="{color}" '
            f'text-anchor="{anchor}" stroke="#FFFFFF" '
            f'stroke-linejoin="round" paint-order="stroke">{esc(value)}</text>'
        )

    svg = header + "\n".join(panels + paths + node_shapes + texts + label_svg) + "\n</svg>\n"
    svg_path = base.with_suffix(".svg")
    png_path = base.with_suffix(".png")
    svg_path.write_text(svg, encoding="utf-8")
    png_w, png_h = round(width * args.scale), round(height * args.scale)
    cairosvg.svg2png(
        bytestring=svg.encode("utf-8"),
        write_to=str(png_path),
        output_width=png_w,
        output_height=png_h,
        background_color="#FFFFFF",
    )
    print(f"Wrote {svg_path}")
    print(f"Wrote {png_path} ({png_w} x {png_h})")


if __name__ == "__main__":
    main()
