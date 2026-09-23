"""One-off icon generator for the Mail Cleaner extension. Not part of the
build; run manually (`python3 scripts/gen-icons.py`) to regenerate icons/
if the design ever changes. Draws at high resolution and downsamples for
crisp anti-aliasing at each required Chrome extension icon size."""

from PIL import Image, ImageDraw

BRAND_BLUE = (79, 124, 255, 255)
WHITE = (255, 255, 255, 255)
SIZE = 512
OUT_SIZES = [16, 48, 128]


def rounded_square(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_envelope(draw, cx, cy, w, h, color, stroke_width):
    left, top = cx - w / 2, cy - h / 2
    right, bottom = cx + w / 2, cy + h / 2
    draw.rounded_rectangle([left, top, right, bottom], radius=w * 0.08, outline=color, width=stroke_width)
    # Envelope flap — a simple V from the top corners to the center.
    draw.line([(left, top), (cx, cy + h * 0.08)], fill=color, width=stroke_width)
    draw.line([(right, top), (cx, cy + h * 0.08)], fill=color, width=stroke_width)


def draw_sparkle(draw, cx, cy, r, color):
    # A simple 4-point star/sparkle to suggest "cleaned".
    points = []
    for i in range(8):
        import math
        angle = math.pi / 4 * i
        radius = r if i % 2 == 0 else r * 0.4
        points.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    draw.polygon(points, fill=color)


def make_icon():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = SIZE * 0.06
    rounded_square(draw, [margin, margin, SIZE - margin, SIZE - margin], radius=SIZE * 0.22, fill=BRAND_BLUE)

    draw_envelope(draw, cx=SIZE * 0.44, cy=SIZE * 0.5, w=SIZE * 0.5, h=SIZE * 0.34, color=WHITE, stroke_width=int(SIZE * 0.045))
    draw_sparkle(draw, cx=SIZE * 0.78, cy=SIZE * 0.26, r=SIZE * 0.09, color=WHITE)

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
