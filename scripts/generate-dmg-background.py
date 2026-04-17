#!/usr/bin/env python3
"""Generate the ShioriCode DMG installer background.

The aesthetic is deliberately "technical blueprint" to match the app icon:
deep navy field, engineering grid, hairline corner registers, numbered step
labels over the two drop points, and a refined dual-weight arrow between
them. Renders both a 1x plate for the DMG window and a @2x plate for
Retina displays.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT / "apps/desktop/resources/dmg-background.png"
OUTPUT_PATH_2X = ROOT / "apps/desktop/resources/dmg-background@2x.png"

WIDTH = 660
HEIGHT = 420

LEFT_ICON_CENTER = (168, 252)
RIGHT_ICON_CENTER = (492, 252)

# Blueprint palette — deep field → luminous accents.
BG_CORE = (16, 32, 58)
BG_EDGE = (4, 9, 20)
GLOW_PRIMARY = (92, 158, 228)
GLOW_SECONDARY = (58, 112, 188)
GRID_MINOR = (120, 168, 228, 16)
GRID_MAJOR = (120, 168, 228, 34)
HAIRLINE = (168, 204, 244, 170)
HAIRLINE_DIM = (168, 204, 244, 90)
TEXT_PRIMARY = (232, 240, 252, 255)
TEXT_MUTED = (148, 174, 212, 230)
TEXT_FAINT = (118, 146, 188, 200)


FONT_CANDIDATES_DISPLAY = (
    "/System/Library/Fonts/SFCompactDisplay.ttf",
    "/System/Library/Fonts/SFCompact.ttf",
    "/System/Library/Fonts/SFNSDisplay.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
)

FONT_CANDIDATES_TEXT = (
    "/System/Library/Fonts/SFNS.ttf",
    "/System/Library/Fonts/SFCompactText.ttf",
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
)

FONT_CANDIDATES_MONO = (
    "/System/Library/Fonts/SFNSMono.ttf",
    "/System/Library/Fonts/Supplemental/Menlo.ttc",
    "/System/Library/Fonts/Menlo.ttc",
    "/System/Library/Fonts/Supplemental/Courier New.ttf",
)


def _load(candidates: tuple[str, ...], size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


def display_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    return _load(FONT_CANDIDATES_DISPLAY, size)


def text_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    return _load(FONT_CANDIDATES_TEXT, size)


def mono_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    return _load(FONT_CANDIDATES_MONO, size)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def sample_cubic_bezier(
    p0: tuple[float, float],
    p1: tuple[float, float],
    p2: tuple[float, float],
    p3: tuple[float, float],
    steps: int = 160,
) -> list[tuple[float, float]]:
    points: list[tuple[float, float]] = []
    for index in range(steps + 1):
        t = index / steps
        mt = 1 - t
        x = (
            mt**3 * p0[0]
            + 3 * mt**2 * t * p1[0]
            + 3 * mt * t**2 * p2[0]
            + t**3 * p3[0]
        )
        y = (
            mt**3 * p0[1]
            + 3 * mt**2 * t * p1[1]
            + 3 * mt * t**2 * p2[1]
            + t**3 * p3[1]
        )
        points.append((x, y))
    return points


class Plate:
    """One rendering plate; `s` scales every geometry constant uniformly."""

    def __init__(self, scale: int) -> None:
        self.s = scale
        self.size = (WIDTH * scale, HEIGHT * scale)
        self.image = Image.new("RGBA", self.size, (0, 0, 0, 255))

    def px(self, v: float) -> int:
        return int(round(v * self.s))

    def pt(self, pt: tuple[float, float]) -> tuple[float, float]:
        return (pt[0] * self.s, pt[1] * self.s)


def paint_field(plate: Plate) -> None:
    """Radial-ish gradient: bright navy core biased toward upper-left, falling off to near-black at the edges."""
    w, h = plate.size
    image = plate.image
    px = image.load()
    cx = w * 0.34
    cy = h * 0.42
    max_d = math.hypot(w, h) * 0.82
    for y in range(h):
        for x in range(w):
            d = math.hypot(x - cx, y - cy) / max_d
            d = min(1.0, d)
            # Ease-out for a soft core, harder falloff near edges.
            t = d * d * (3 - 2 * d)
            r = int(lerp(BG_CORE[0], BG_EDGE[0], t))
            g = int(lerp(BG_CORE[1], BG_EDGE[1], t))
            b = int(lerp(BG_CORE[2], BG_EDGE[2], t))
            px[x, y] = (r, g, b, 255)


def paint_grid(plate: Plate) -> None:
    s = plate.s
    layer = Image.new("RGBA", plate.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    minor_step = 24 * s
    major_step = 96 * s
    w, h = plate.size
    for x in range(0, w + 1, minor_step):
        draw.line([(x, 0), (x, h)], fill=GRID_MINOR, width=1)
    for y in range(0, h + 1, minor_step):
        draw.line([(0, y), (w, y)], fill=GRID_MINOR, width=1)
    for x in range(0, w + 1, major_step):
        draw.line([(x, 0), (x, h)], fill=GRID_MAJOR, width=1)
    for y in range(0, h + 1, major_step):
        draw.line([(0, y), (w, y)], fill=GRID_MAJOR, width=1)
    plate.image.alpha_composite(layer)


def paint_vignette(plate: Plate) -> None:
    """Darken the corners subtly so the grid recedes where content isn't."""
    w, h = plate.size
    mask = Image.new("L", plate.size, 0)
    md = ImageDraw.Draw(mask)
    cx, cy = w / 2, h / 2
    max_r = math.hypot(cx, cy)
    rings = 90
    for i in range(rings):
        t = i / (rings - 1)
        r = max_r * (1 - t)
        alpha = int(130 * (t**2.2))
        bbox = (cx - r, cy - r, cx + r, cy + r)
        md.ellipse(bbox, fill=alpha)
    dark = Image.new("RGBA", plate.size, (0, 0, 0, 0))
    dark.putalpha(mask)
    plate.image.alpha_composite(dark)


def paint_corner_registers(plate: Plate) -> None:
    """Thin hairline L-brackets at each corner. No labels — just a subtle frame."""
    s = plate.s
    draw = ImageDraw.Draw(plate.image)
    inset = 22 * s
    length = 14 * s
    w, h = plate.size

    def bracket(x: float, y: float, dx: int, dy: int) -> None:
        draw.line([(x, y), (x + dx * length, y)], fill=HAIRLINE_DIM, width=max(1, s // 2))
        draw.line([(x, y), (x, y + dy * length)], fill=HAIRLINE_DIM, width=max(1, s // 2))

    bracket(inset, inset, 1, 1)
    bracket(w - inset, inset, -1, 1)
    bracket(inset, h - inset, 1, -1)
    bracket(w - inset, h - inset, -1, -1)


def paint_header(plate: Plate) -> None:
    s = plate.s
    draw = ImageDraw.Draw(plate.image)
    w, _ = plate.size

    heading = display_font(30 * s)
    subtitle = text_font(14 * s)

    draw.text(
        (w / 2, 70 * s),
        "Install ShioriCode",
        font=heading,
        fill=TEXT_PRIMARY,
        anchor="mm",
    )
    draw.text(
        (w / 2, 100 * s),
        "Drag the app into your Applications folder.",
        font=subtitle,
        fill=TEXT_MUTED,
        anchor="mm",
    )


def paint_source_aura(plate: Plate) -> None:
    """Luminous circular glow + concentric hairline rings behind the app icon."""
    s = plate.s
    center = plate.pt(LEFT_ICON_CENTER)

    glow = Image.new("RGBA", plate.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    # Layered soft glow.
    for radius, alpha in ((132, 38), (96, 60), (64, 80)):
        gd.ellipse(
            (
                center[0] - radius * s,
                center[1] - radius * s,
                center[0] + radius * s,
                center[1] + radius * s,
            ),
            fill=(*GLOW_PRIMARY, alpha),
        )
    glow = glow.filter(ImageFilter.GaussianBlur(22 * s))
    plate.image.alpha_composite(glow)

    # A single outer ring, sized so it stays visible around the 128px app icon.
    draw = ImageDraw.Draw(plate.image)
    radius = 98
    bbox = (
        center[0] - radius * s,
        center[1] - radius * s,
        center[0] + radius * s,
        center[1] + radius * s,
    )
    draw.ellipse(bbox, outline=(*GLOW_PRIMARY, 110), width=max(1, s // 2))


def paint_dashed_rounded_rect(
    plate: Plate,
    center: tuple[float, float],
    half: float,
    radius: float,
    color: tuple[int, int, int, int],
    dash: float = 8.0,
    gap: float = 6.0,
    width: int = 2,
) -> None:
    """Draw a dashed rounded square centered on `center` with half-side `half`."""
    s = plate.s
    cx, cy = plate.pt(center)
    half *= s
    radius *= s
    dash *= s
    gap *= s
    left = cx - half
    right = cx + half
    top = cy - half
    bottom = cy + half

    draw = ImageDraw.Draw(plate.image)

    def dashed_line(p0: tuple[float, float], p1: tuple[float, float]) -> None:
        x0, y0 = p0
        x1, y1 = p1
        length = math.hypot(x1 - x0, y1 - y0)
        if length == 0:
            return
        ux = (x1 - x0) / length
        uy = (y1 - y0) / length
        dist = 0.0
        while dist < length:
            end = min(length, dist + dash)
            sx, sy = x0 + ux * dist, y0 + uy * dist
            ex, ey = x0 + ux * end, y0 + uy * end
            draw.line([(sx, sy), (ex, ey)], fill=color, width=width)
            dist = end + gap

    # Four straight edges.
    dashed_line((left + radius, top), (right - radius, top))
    dashed_line((right, top + radius), (right, bottom - radius))
    dashed_line((right - radius, bottom), (left + radius, bottom))
    dashed_line((left, bottom - radius), (left, top + radius))

    # Corners as short dashed arcs approximated by arc + stippled mask.
    def dashed_arc(
        center_pt: tuple[float, float], start_deg: float, end_deg: float
    ) -> None:
        steps = 12
        r = radius
        cx_, cy_ = center_pt
        prev: tuple[float, float] | None = None
        accum = 0.0
        pen_down = True
        thresh = dash if pen_down else gap
        for i in range(steps + 1):
            t = i / steps
            ang = math.radians(lerp(start_deg, end_deg, t))
            x = cx_ + r * math.cos(ang)
            y = cy_ + r * math.sin(ang)
            if prev is not None:
                seg = math.hypot(x - prev[0], y - prev[1])
                accum += seg
                if pen_down:
                    draw.line([prev, (x, y)], fill=color, width=width)
                if accum >= thresh:
                    pen_down = not pen_down
                    thresh = dash if pen_down else gap
                    accum = 0.0
            prev = (x, y)

    dashed_arc((left + radius, top + radius), 180, 270)
    dashed_arc((right - radius, top + radius), 270, 360)
    dashed_arc((right - radius, bottom - radius), 0, 90)
    dashed_arc((left + radius, bottom - radius), 90, 180)


def paint_destination_target(plate: Plate) -> None:
    """Dashed drop-target ring around the Applications folder alias."""
    s = plate.s

    # Soft cool glow behind the target.
    glow = Image.new("RGBA", plate.size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    center = plate.pt(RIGHT_ICON_CENTER)
    gd.rounded_rectangle(
        (
            center[0] - 96 * s,
            center[1] - 96 * s,
            center[0] + 96 * s,
            center[1] + 96 * s,
        ),
        radius=22 * s,
        fill=(*GLOW_SECONDARY, 60),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(26 * s))
    plate.image.alpha_composite(glow)

    paint_dashed_rounded_rect(
        plate,
        RIGHT_ICON_CENTER,
        half=82,
        radius=20,
        color=(*GLOW_PRIMARY, 200),
        dash=10,
        gap=6,
        width=max(2, s),
    )


def paint_arrow(plate: Plate) -> None:
    s = plate.s
    # A gentler, more horizontal curve — reads as "sweep right", not "arc over".
    start = (LEFT_ICON_CENTER[0] + 104, LEFT_ICON_CENTER[1] + 6)
    end = (RIGHT_ICON_CENTER[0] - 106, RIGHT_ICON_CENTER[1] + 6)
    ctrl1 = (start[0] + 70, start[1] - 44)
    ctrl2 = (end[0] - 70, end[1] - 44)

    points = [plate.pt(p) for p in sample_cubic_bezier(start, ctrl1, ctrl2, end)]

    # Clip the tail so the shaft stops cleanly behind the arrowhead base.
    tail = points[-1]
    anchor = points[-14 if len(points) >= 14 else 0]
    angle = math.atan2(tail[1] - anchor[1], tail[0] - anchor[0])
    head_len = 20 * s
    head_w = 15 * s
    tip = tail
    base_cx = tip[0] - head_len * math.cos(angle)
    base_cy = tip[1] - head_len * math.sin(angle)
    # Trim the last segment so the line ends at the arrowhead base.
    shaft = points[:-1] + [(base_cx, base_cy)]

    # Soft underglow so the arrow reads on the dark field.
    under = Image.new("RGBA", plate.size, (0, 0, 0, 0))
    ud = ImageDraw.Draw(under)
    ud.line(shaft, fill=(*GLOW_PRIMARY, 120), width=14 * s, joint="curve")
    under = under.filter(ImageFilter.GaussianBlur(6 * s))
    plate.image.alpha_composite(under)

    arrow = Image.new("RGBA", plate.size, (0, 0, 0, 0))
    ad = ImageDraw.Draw(arrow)

    # Main stroke.
    ad.line(shaft, fill=(*GLOW_PRIMARY, 255), width=6 * s, joint="curve")
    # Inner spine highlight.
    ad.line(shaft, fill=(235, 245, 255, 220), width=2 * s, joint="curve")

    left_corner = (
        base_cx + (head_w / 2) * math.sin(angle),
        base_cy - (head_w / 2) * math.cos(angle),
    )
    right_corner = (
        base_cx - (head_w / 2) * math.sin(angle),
        base_cy + (head_w / 2) * math.cos(angle),
    )
    ad.polygon([tip, left_corner, right_corner], fill=(*GLOW_PRIMARY, 255))

    plate.image.alpha_composite(arrow)


def render(scale: int) -> Image.Image:
    plate = Plate(scale)
    paint_field(plate)
    paint_grid(plate)
    paint_vignette(plate)
    paint_corner_registers(plate)
    paint_header(plate)
    paint_source_aura(plate)
    paint_destination_target(plate)
    paint_arrow(plate)
    return plate.image


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    base = render(1)
    retina = render(2)
    base.save(OUTPUT_PATH)
    retina.save(OUTPUT_PATH_2X)
    print(OUTPUT_PATH)
    print(OUTPUT_PATH_2X)


if __name__ == "__main__":
    main()
