"""生成 DocMax 桌面快捷方式图标（多尺寸 .ico）。

用法（需要 Pillow）：
  python scripts/make-icon.py
产物：assets/docmax.ico
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "docmax.ico"

DARK = (27, 26, 24, 255)
PAPER = (250, 248, 242, 255)
ACCENT = (217, 122, 95, 255)
ACCENT_SOFT = (240, 196, 178, 255)


def star_points(cx: float, cy: float, outer: float, inner: float, points: int = 4) -> list[tuple[float, float]]:
    """四角星的顶点（上下左右为长尖，斜向为内凹）。"""
    import math

    result: list[tuple[float, float]] = []
    for i in range(points * 2):
        radius = outer if i % 2 == 0 else inner
        angle = -math.pi / 2 + i * math.pi / points
        result.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return result


def render(size: int) -> Image.Image:
    scale = 4
    canvas = size * scale
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    pad = canvas * 0.045
    radius = canvas * 0.24
    draw.rounded_rectangle(
        (pad, pad, canvas - pad, canvas - pad),
        radius=radius,
        fill=DARK,
        outline=(60, 56, 50, 255),
        width=max(1, int(canvas * 0.006)),
    )

    # 主四角星
    draw.polygon(star_points(canvas / 2, canvas / 2, canvas * 0.34, canvas * 0.105), fill=ACCENT)
    # 中心高光
    draw.ellipse(
        (
            canvas * 0.5 - canvas * 0.045,
            canvas * 0.5 - canvas * 0.045,
            canvas * 0.5 + canvas * 0.045,
            canvas * 0.5 + canvas * 0.045,
        ),
        fill=PAPER,
    )
    # 小点缀：右下角一颗小星，呼应界面的 "✦"
    draw.polygon(star_points(canvas * 0.75, canvas * 0.24, canvas * 0.075, canvas * 0.024), fill=ACCENT_SOFT)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [render(size) for size in sizes]
    images[-1].save(OUT, format="ICO", sizes=[(size, size) for size in sizes], append_images=images[:-1])
    print(f"[ok] {OUT} ({OUT.stat().st_size} bytes, sizes={sizes})")


if __name__ == "__main__":
    main()
