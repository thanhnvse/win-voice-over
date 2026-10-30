"""Draws the extension icon: a white bold "W" on a blue rounded square.

Each size is drawn large and scaled down, so the edges stay smooth.
Usage: python scripts/make-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "extension" / "icons"
SIZES = (16, 32, 48, 128)
BLUE = (37, 99, 235, 255)
WHITE = (255, 255, 255, 255)
CANVAS = 512
FONT = Path("C:/Windows/Fonts/segoeuib.ttf")


def draw_master() -> Image.Image:
    image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((0, 0, CANVAS - 1, CANVAS - 1), radius=int(CANVAS * 0.22), fill=BLUE)

    font = ImageFont.truetype(str(FONT), int(CANVAS * 0.66))
    # Centre the glyph's ink, not its advance box, so the W sits optically in the middle.
    left, top, right, bottom = draw.textbbox((0, 0), "W", font=font)
    x = (CANVAS - (right - left)) / 2 - left
    y = (CANVAS - (bottom - top)) / 2 - top
    draw.text((x, y), "W", font=font, fill=WHITE)
    return image


def main() -> None:
    if not FONT.exists():
        raise SystemExit(f"font not found: {FONT}")
    OUT.mkdir(parents=True, exist_ok=True)
    master = draw_master()
    for size in SIZES:
        path = OUT / f"icon-{size}.png"
        master.resize((size, size), Image.LANCZOS).save(path)
        print(f"wrote {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
