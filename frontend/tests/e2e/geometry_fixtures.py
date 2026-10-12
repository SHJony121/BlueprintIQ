"""Extra geometry fixtures for the browser alignment tests (F3). Test-only.

Usage: <backend python> tests/e2e/geometry_fixtures.py <output dir>   (any working directory)

The committed fixtures (backend/tests/fixtures) cover all four rotations and crop
offsets, but none has text near a page edge, a 180 degree page with an offset crop, a
negative crop origin, a landscape sheet, or several boxes for one finding. These cases are
written with the backend's own dependency-free PDF writer, and their ground truth (where
each line's ink lies, in page space) comes from that writer's Adobe font metrics. Neither
uses BlueprintIQ's extraction or the frontend's geometry code.

Every annotation is one the backend recognizes, so the cases it accepts also produce real
evidence when uploaded through the app.
"""

import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[3] / "backend"
sys.path.insert(0, str(BACKEND))

from tests.fixtures.synthetic_pdf import (  # noqa: E402
    FONT_METRICS,
    DocumentSpec,
    PageSpec,
    TextRun,
    build_pdf,
    text_width,
)

SIZE = 10.0
# Points between each ink box and the page edge. The backend accepts 3 pt (at 2 pt it
# refuses the text as cut off by the edge), so the 3 pt cases also run through the real
# app; the 1.5 pt cases are checked against ground truth only.
APP_MARGIN = 3.0
TIGHT_MARGIN = 1.5
ASCENT, DESCENT = (v * SIZE for v in FONT_METRICS["Helvetica"])

CORNER_TEXT = ("THICKNESS: 4 mm", "DIAMETER: 20 mm", "LENGTH: 120 mm", "MATERIAL: SS400")

Box = tuple[float, float, float, float]


def corners(width: float, height: float, margin: float) -> tuple[TextRun, ...]:
    """One annotation in each corner of a width x height page, `margin` pt from the edges."""
    top = margin + ASCENT
    bottom = height - margin - DESCENT
    tl, tr, bl, br = CORNER_TEXT

    def right(text: str) -> float:
        return width - margin - text_width(text, "Helvetica", SIZE)

    return (
        TextRun(tl, x=margin, baseline=top),
        TextRun(tr, x=right(tr), baseline=top),
        TextRun(bl, x=margin, baseline=bottom),
        TextRun(br, x=right(br), baseline=bottom),
    )


def one_page(
    media: Box, rotate: int = 0, crop: Box | None = None, margin: float = APP_MARGIN
) -> DocumentSpec:
    visible = PageSpec(media_box=media, crop_box=crop, rotate=rotate).visible_box
    runs = corners(visible[2] - visible[0], visible[3] - visible[1], margin)
    return DocumentSpec(pages=(PageSpec(media_box=media, crop_box=crop, rotate=rotate, runs=runs),))


def cases() -> dict[str, tuple[DocumentSpec, bool]]:
    """name -> (document, whether the backend accepts it)."""
    a4: Box = (0.0, 0.0, 595.0, 842.0)
    found: dict[str, tuple[DocumentSpec, bool]] = {}
    for rotate in (0, 90, 180, 270):
        found[f"edges_r{rotate}"] = (one_page(a4, rotate), True)
        found[f"edges_tight_r{rotate}"] = (one_page(a4, rotate, margin=TIGHT_MARGIN), False)

    found["offset_crop_r180"] = (
        one_page((0.0, 0.0, 800.0, 1000.0), 180, crop=(130.0, 70.0, 560.0, 690.0)),
        True,
    )
    negative = one_page((-400.0, -300.0, 300.0, 600.0), 270, crop=(-350.0, -250.0, 250.0, 550.0))
    found["negative_origin_inherited_r270"] = (
        DocumentSpec(pages=negative.pages, inherit_boxes=True),
        True,
    )
    found["landscape_r90"] = (one_page((0.0, 0.0, 842.0, 595.0), 90), True)

    multi = (
        TextRun("THICKNESS: 4 mm", x=72, baseline=120),
        TextRun("THICKNESS: 5 mm", x=72, baseline=160),  # two thicknesses: one finding, two boxes
        TextRun("DIAMETER: 20 mm", x=300, baseline=120),
        TextRun("DIAMETER: 60 mm", x=300, baseline=160),  # two holes: one pass, one fail
        TextRun("LENGTH: 120 mm", x=72, baseline=200),
        TextRun("MATERIAL: SS400", x=300, baseline=200),
    )
    found["multi_box_r0"] = (DocumentSpec(pages=(PageSpec(media_box=a4, runs=multi),)), True)
    return found


def ground_truth(name: str, doc: DocumentSpec, backend_accepts: bool) -> dict[str, object]:
    spec = doc.pages[0]
    box = spec.visible_box
    return {
        "name": name,
        "backend_accepts": backend_accepts,
        "page": {
            "width_pt": box[2] - box[0],
            "height_pt": box[3] - box[1],
            "rotation": spec.rotate,
            "pdf_crop_box": list(box),
        },
        "lines": [
            {
                "text": run.text,
                "ink_box": [round(v, 4) for v in run.ink_box()],
                "font_size": run.size,
                "advance_axis": "x",  # all horizontal in page space
            }
            for run in spec.runs
        ],
    }


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    found = cases()
    for name, (doc, accepts) in found.items():
        (out / f"{name}.pdf").write_bytes(build_pdf(doc))
        text = json.dumps(ground_truth(name, doc, accepts), indent=2) + "\n"
        (out / f"{name}.json").write_text(text, encoding="utf-8")
    print(f"wrote {len(found)} fixtures to {out}")


if __name__ == "__main__":
    main()
