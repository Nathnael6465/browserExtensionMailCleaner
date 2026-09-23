"""One-off icon generator for the Mail Cleaner extension. Not part of the
build; run manually (`python3 scripts/gen-icons.py`) to regenerate icons/
if the design ever changes. Draws at high resolution and downsamples for
crisp anti-aliasing at each required Chrome extension icon size.

Design: a white envelope with Gmail-style red edges/trim, being swept by
a broom -- no sparkle/star.
"""

import math
from PIL import Image, ImageDraw

BRAND_BLUE = (79, 124, 255, 255)
WHITE = (255, 255, 255, 255)
GMAIL_RED = (219, 68, 55, 255)
HANDLE_GRAY = (150, 158, 168, 255)
HANDLE_GRAY_DARK = (110, 118, 128, 255)
BRISTLE = (235, 238, 242, 255)
BRISTLE_LINE = (200, 206, 214, 255)

SIZE = 512
OUT_SIZES = [16, 48, 128]


def draw_envelope(draw, cx, cy, w, h):
    left, top = cx - w / 2, cy - h / 2
    right, bottom = cx + w / 2, cy + h / 2
    radius = w * 0.07
    stroke = max(2, int(w * 0.045))

    # White body, Gmail-red outline -- same trim color the flap lines use.
    draw.rounded_rectangle([left, top, right, bottom], radius=radius, fill=WHITE, outline=GMAIL_RED, width=stroke)
    draw.line([(left + stroke, top + stroke * 0.5), (cx, cy + h * 0.1)], fill=GMAIL_RED, width=stroke)
    draw.line([(right - stroke, top + stroke * 0.5), (cx, cy + h * 0.1)], fill=GMAIL_RED, width=stroke)


def draw_broom(size):
    """Broom drawn horizontally (handle pointing left, head pointing
    right) on its own transparent layer, so it can be rotated as a whole
    to get the diagonal sweeping angle without distorting the shape."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cy = size / 2

    handle_len = size * 0.62
    handle_w = size * 0.075
    handle_left = size * 0.06
    handle_right = handle_left + handle_len
    d.rounded_rectangle(
        [handle_left, cy - handle_w / 2, handle_right, cy + handle_w / 2],
        radius=handle_w / 2,
        fill=HANDLE_GRAY,
        outline=HANDLE_GRAY_DARK,
        width=max(1, int(size * 0.006)),
    )

    # Head: a fanned trapezoid flaring out from the handle's end.
    head_left = handle_right - size * 0.03
    head_right = size * 0.98
    neck_half = handle_w * 0.7
    fan_half = size * 0.16
    head_poly = [
        (head_left, cy - neck_half),
        (head_right, cy - fan_half),
        (head_right, cy + fan_half),
        (head_left, cy + neck_half),
    ]
    d.polygon(head_poly, fill=BRISTLE, outline=HANDLE_GRAY_DARK)

    # A few bristle separator lines for texture.
    for t in (-0.5, 0.0, 0.5):
        y0 = cy + neck_half * t
        y1 = cy + fan_half * t * 1.4
        d.line([(head_left + size * 0.01, y0), (head_right - size * 0.01, y1)], fill=BRISTLE_LINE, width=max(1, int(size * 0.008)))

    return layer


def make_icon():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = SIZE * 0.06
    draw.rounded_rectangle([margin, margin, SIZE - margin, SIZE - margin], radius=SIZE * 0.22, fill=BRAND_BLUE)

    draw_envelope(draw, cx=SIZE * 0.46, cy=SIZE * 0.52, w=SIZE * 0.56, h=SIZE * 0.38)

    broom = draw_broom(SIZE)
    broom = broom.rotate(-38, resample=Image.BICUBIC, expand=False, center=(SIZE * 0.5, SIZE * 0.5))
    # Shift so the broom head sweeps across the envelope's lower-right,
    # handle trailing off toward the upper-left corner (mirrors the
    # reference: head over the mail, handle extending out and away).
    offset = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    offset.paste(broom, (int(SIZE * -0.06), int(SIZE * 0.08)), broom)
    img = Image.alpha_composite(img, offset)

    return img


def main():
    base = make_icon()
    for size in OUT_SIZES:
        resized = base.resize((size, size), Image.LANCZOS)
        path = f"icons/icon{size}.png"
        resized.save(path)
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
