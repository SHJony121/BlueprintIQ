"""Write the original sample drawings the website offers ("Try a sample").

Usage (from backend/):  uv run python scripts/generate_samples.py

The PDFs are original synthetic content produced by the dependency-free writer in
tests/fixtures/synthetic_pdf.py: invented parts, invented numbers, no company or standard.
They contain no real drawing, title block or wording from any third party. Output is
deterministic; a test checks that the committed files match what this script produces.
"""

import math
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from tests.fixtures.synthetic_pdf import (  # noqa: E402
    DocumentSpec,
    PageSpec,
    Shape,
    TextRun,
    build_pdf,
    text_width,
)

SAMPLES = BACKEND.parent / "frontend" / "public" / "samples"
SIZE = 10.0
A4 = (0.0, 0.0, 595.0, 842.0)

BASIC = "blueprintiq-sample-basic.pdf"
CAD = "blueprintiq-sample-cad.pdf"
FEATURES = "blueprintiq-sample-features.pdf"
REVIEW = "blueprintiq-sample-review.pdf"


def line(x0: float, y0: float, x1: float, y1: float) -> Shape:
    return Shape("line", (x0, y0, x1, y1))


def arrow(tip: tuple[float, float], toward: tuple[float, float], length: float = 10.0) -> Shape:
    ux, uy = toward
    bx, by = tip[0] - ux * length, tip[1] - uy * length
    hw = length / 4
    px, py = -uy, ux
    return Shape(
        "fillpoly", (tip[0], tip[1], bx + px * hw, by + py * hw, bx - px * hw, by - py * hw)
    )


def text(label: str, x: float, baseline: float, size: float = SIZE) -> TextRun:
    return TextRun(label, x, baseline, size=size)


def centred(label: str, x_mid: float, baseline: float) -> TextRun:
    return text(label, x_mid - text_width(label, "Helvetica", SIZE) / 2, baseline)


def rect_outline(x0: float, y0: float, x1: float, y1: float) -> list[Shape]:
    return [line(x0, y0, x1, y0), line(x1, y0, x1, y1), line(x1, y1, x0, y1), line(x0, y1, x0, y0)]


def basic() -> bytes:
    """Sample A: a labelled plate. Four annotations, one of them below the demo minimum."""
    runs = (
        text("BlueprintIQ sample A: labelled plate", 72, 80, 14),
        text("Original synthetic example. Not a real part.", 72, 100),
        text("THICKNESS: 2.5 mm", 72, 170),
        text("DIAMETER: 20 mm", 72, 190),
        text("LENGTH: 120 mm", 72, 210),
        text("MATERIAL: S235JR", 72, 230),
    )
    shapes = (
        *rect_outline(72, 300, 392, 520),
        Shape("polycircle", (232, 410, 40, 64)),
    )
    page = PageSpec(media_box=A4, runs=runs, shapes=shapes)
    return build_pdf(DocumentSpec(pages=(page,)))


def cad() -> bytes:
    """Sample B: a plate in CAD style with dimension graphics and a stacked tolerance."""
    shapes: list[Shape] = []
    runs: list[TextRun] = [
        text("BlueprintIQ sample B: CAD-style plate", 72, 80, 14),
        text("Original synthetic example. Not a real part.", 72, 100),
        text("All dimensions are in millimeter", 72, 780),
        text("THICKNESS: 4 mm", 72, 140),
        text("DIAMETER: 20 mm", 72, 160),
        text("LENGTH: 120 mm", 72, 180),
        text("Material: S235JR", 72, 200),
    ]

    # Part outline and a round hole.
    x0, y0, x1, y1 = 150.0, 260.0, 450.0, 460.0
    shapes += rect_outline(x0, y0, x1, y1)
    cx, cy, r = 300.0, 360.0, 36.0
    shapes.append(Shape("polycircle", (cx, cy, r, 64)))

    # Overall width, dimension line below the part, plain value.
    yd = y1 + 50
    shapes += [line(x0, y1 + 5, x0, yd + 8), line(x1, y1 + 5, x1, yd + 8), line(x0, yd, x1, yd)]
    shapes += [arrow((x0, yd), (-1, 0)), arrow((x1, yd), (1, 0))]
    runs.append(centred("120", (x0 + x1) / 2, yd - 3))

    # Height, vertical dimension line left of the part is rotated text in CAD exports, which
    # the reader skips; the second linear dimension therefore sits above the part instead.
    ya = y0 - 50
    xa, xb = 190.0, 410.0
    shapes += [line(xa, y0 - 5, xa, ya - 8), line(xb, y0 - 5, xb, ya - 8), line(xa, ya, xb, ya)]
    shapes += [arrow((xa, ya), (-1, 0)), arrow((xb, ya), (1, 0))]
    runs.append(centred("88 ±0.1", (xa + xb) / 2, ya - 3))

    # Stacked tolerance: a value with its upper and lower deviation printed on two lines.
    ys = yd + 60
    xs0, xs1 = 150.0, 330.0
    shapes += [
        line(xs0, y1 + 5, xs0, ys + 8),
        line(xs1, y1 + 5, xs1, ys + 8),
        line(xs0, ys, xs1, ys),
    ]
    shapes += [arrow((xs0, ys), (-1, 0)), arrow((xs1, ys), (1, 0))]
    value = "60"
    vw = text_width(value, "Helvetica", SIZE)
    vx = (xs0 + xs1) / 2 - vw / 2 - 8
    runs.append(text(value, vx, ys - 3))
    runs.append(text("+0", vx + vw + 4, ys - 3 - 6, 6))
    runs.append(text("-0.2", vx + vw + 4, ys - 3 + 9, 6))

    # Diameter leader to the hole, ending on the circle along a radius.
    theta = math.radians(-45)
    tip = (cx + r * math.cos(theta), cy + r * math.sin(theta))
    start = (tip[0] + 60 * math.cos(theta), tip[1] + 60 * math.sin(theta))
    shapes += [line(*start, *tip), arrow(tip, (-math.cos(theta), -math.sin(theta)))]
    runs.append(text("Ø20", start[0] + 2, start[1] - 1))

    # A dimension drawn without arrowheads or extension lines: the reader keeps the number
    # but cannot tie it to geometry, and says so.
    yu = y0 + 40
    shapes.append(line(x1 + 30, yu, x1 + 110, yu))
    runs.append(text("30", x1 + 60, yu - 3))

    page = PageSpec(media_box=A4, runs=tuple(runs), shapes=tuple(shapes))
    return build_pdf(DocumentSpec(pages=(page,)))


def leader(
    cx: float, cy: float, r: float, theta_deg: float, label: str, length: float = 50.0
) -> tuple[list[Shape], TextRun]:
    """A leader from a text down to the point at ``theta_deg`` on a circle or arc, pointing
    along the radius, with an arrowhead on the curve."""
    theta = math.radians(theta_deg)
    tip = (cx + r * math.cos(theta), cy + r * math.sin(theta))
    start = (tip[0] + length * math.cos(theta), tip[1] + length * math.sin(theta))
    shapes = [line(*start, *tip), arrow(tip, (-math.cos(theta), -math.sin(theta)))]
    return shapes, text(label, start[0] + 2, start[1] - 1)


def features() -> bytes:
    """Sample C: a plate with a rounded corner, a chamfer and a hole. Shows a radius tied to its
    arc, a toleranced diameter, an asymmetric tolerance, and an angle that is read but not tied
    to geometry (angle associations are not supported)."""
    shapes: list[Shape] = []
    runs: list[TextRun] = [
        text("BlueprintIQ sample C: radius, tolerances and an angle", 72, 80, 14),
        text("Original synthetic example. Not a real part.", 72, 100),
        text("All dimensions are in millimeter", 72, 780),
        text("THICKNESS: 5 mm", 72, 140),
        text("DIAMETER: 12 mm", 72, 160),
        text("LENGTH: 160 mm", 72, 180),
        text("MATERIAL: AW-5754", 72, 200),
    ]

    # Outline: rounded top-right corner (radius 30) and a chamfered bottom-left corner.
    x0, y0, x1, y1, corner = 150.0, 300.0, 430.0, 470.0, 30.0
    shapes += [
        line(x0, y0, x1 - corner, y0),
        Shape("polyarc", (x1 - corner, y0 + corner, corner, -90, 0, 24)),
        line(x1, y0 + corner, x1, y1),
        line(x1, y1, x0 + 30, y1),
        line(x0 + 30, y1, x0, y1 - 30),
        line(x0, y1 - 30, x0, y0),
    ]

    # Radius leader onto the rounded corner.
    arc_shapes, arc_text = leader(x1 - corner, y0 + corner, corner, -45, "R30")
    shapes += arc_shapes
    runs.append(arc_text)

    # A hole with a toleranced diameter on a leader.
    cx, cy, r = 230.0, 400.0, 25.0
    shapes.append(Shape("polycircle", (cx, cy, r, 64)))
    hole_shapes, hole_text = leader(cx, cy, r, -45, "\u00d812 \u00b10.05", length=45)
    shapes += hole_shapes
    runs.append(hole_text)

    # Overall width below the part, with an asymmetric tolerance on one line.
    yd = y1 + 50
    shapes += [line(x0, y1 - 25, x0, yd + 8), line(x1, y1 + 5, x1, yd + 8), line(x0, yd, x1, yd)]
    shapes += [arrow((x0, yd), (-1, 0)), arrow((x1, yd), (1, 0))]
    runs.append(centred("160 +0.2/-0.1", (x0 + x1) / 2, yd - 3))

    # The chamfer angle: read as an angle; tying an angle to geometry is not supported.
    runs.append(text("45\u00b0 \u00b10.5\u00b0", 80, y1 + 10))

    page = PageSpec(media_box=A4, runs=tuple(runs), shapes=tuple(shapes))
    return build_pdf(DocumentSpec(pages=(page,)))


def review() -> bytes:
    """Sample D: annotations that must not be guessed. No drawing-wide unit note, a value
    without a unit, a comma decimal, two different materials, a toleranced diameter with no
    unit, and a lone tolerance fragment. BlueprintIQ should ask for a person, not pass these."""
    shapes: list[Shape] = [
        *rect_outline(150, 300, 430, 470),
        Shape("polycircle", (290, 385, 30, 64)),
    ]
    runs = (
        text("BlueprintIQ sample D: annotations that need a person", 72, 80, 14),
        text("Original synthetic example. Not a real part.", 72, 100),
        text("THICKNESS: 4", 72, 140),
        text("DIAMETER: 2,5 mm", 72, 160),
        text("LENGTH: 120 mm", 72, 180),
        text("MATERIAL: S235JR", 72, 200),
        text("MATERIAL: S355J2", 72, 220),
        text("\u00d812 \u00b10.05", 340, 330),
        text("+0.1", 200, 500),
    )
    page = PageSpec(media_box=A4, runs=runs, shapes=tuple(shapes))
    return build_pdf(DocumentSpec(pages=(page,)))


def render() -> dict[Path, bytes]:
    return {
        SAMPLES / BASIC: basic(),
        SAMPLES / CAD: cad(),
        SAMPLES / FEATURES: features(),
        SAMPLES / REVIEW: review(),
    }


def main() -> None:
    SAMPLES.mkdir(parents=True, exist_ok=True)
    for path, data in render().items():
        path.write_bytes(data)
        print(f"wrote {path.name} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
