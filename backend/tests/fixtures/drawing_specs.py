"""Synthetic drawing fixtures and their independently specified ground truth.

Every expected value here is written by hand or derived from PDF geometry and
published font metrics (``synthetic_pdf.TextRun.ink_box``). Nothing is produced by
running BlueprintIQ's extraction code. ``scripts/generate_fixtures.py`` writes each
fixture to ``tests/fixtures/drawings/<name>.pdf`` and its ground truth to
``tests/fixtures/expected/<name>.json``.

Page-space coordinates (canonical): origin at the top-left of the visible page
(CropBox), y down, points, *unrotated* page. "Viewer" positions below are where a
reader sees the text after the page's /Rotate is applied (clockwise).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from tests.fixtures.synthetic_pdf import (
    Continuation,
    DocumentSpec,
    PageSpec,
    Shape,
    TextRun,
    text_width,
)

A4 = (0.0, 0.0, 595.0, 842.0)


@dataclass(frozen=True)
class ExpectedLine:
    text: str
    run: TextRun

    def as_json(self) -> dict[str, Any]:
        sizes = [self.run.size, *(c.size for c in self.run.continuation)]
        return {
            "text": self.text,
            "ink_box": [round(v, 3) for v in self.run.ink_box()],
            "font_size": max(sizes),
            "advance_axis": "x" if self.run.angle in (0, 180) else "y",
        }


@dataclass(frozen=True)
class Fixture:
    name: str
    description: str
    doc: DocumentSpec
    lines: tuple[ExpectedLine, ...] = ()
    measurements: tuple[dict[str, Any], ...] = ()
    unrecognized: tuple[str, ...] = ()
    hidden_lines: int = 0
    error: str | None = None
    page: dict[str, Any] = field(default_factory=dict)

    def as_json(self) -> dict[str, Any]:
        data: dict[str, Any] = {"name": self.name, "description": self.description}
        if self.error is not None:
            data["error"] = self.error
            return data
        data |= {
            "page": self.page,
            "lines": [line.as_json() for line in self.lines],
            "hidden_lines": self.hidden_lines,
            "measurements": list(self.measurements),
            "unrecognized": list(self.unrecognized),
        }
        return data


# ----------------------------------------------------------------- helpers


def dim(
    mid: str, dtype: str, raw: str, value: str | None, unit: str | None,
    normalized: str | None, issues: tuple[str, ...] = (),
) -> dict[str, Any]:  # fmt: skip
    return {
        "id": mid,
        "kind": "dimension",
        "dimension_type": dtype,
        "raw_text": raw,
        "value": value,
        "unit": unit,
        "normalized_value_mm": normalized,
        "status": "ambiguous" if issues else "parsed",
        "issues": list(issues),
    }


def mat(mid: str, raw: str, value: str | None, issues: tuple[str, ...] = ()) -> dict[str, Any]:
    return {
        "id": mid,
        "kind": "material",
        "raw_text": raw,
        "value": value,
        "status": "ambiguous" if issues else "parsed",
        "issues": list(issues),
    }


def page_meta(spec: PageSpec) -> dict[str, Any]:
    return {
        "width_pt": spec.width,
        "height_pt": spec.height,
        "rotation": spec.rotate,
        "pdf_crop_box": list(spec.visible_box),  # PDF user space, as written in the file
    }


def annotation_runs(
    texts: tuple[str, ...], x: float = 72.0, first: float = 560.0
) -> tuple[TextRun, ...]:
    return tuple(TextRun(t, x, first + 20.0 * i) for i, t in enumerate(texts))


TITLE_RUNS = (
    TextRun("TITLE: BRACKET", 330, 725),
    TextRun("SCALE: 1:2", 330, 745),
    TextRun("DRAWN: SYNTHETIC FIXTURE", 330, 765),
)
TITLE_LABELS = ("TITLE", "SCALE", "DRAWN")
PART_SHAPES = (
    Shape("rect", (60, 120, 535, 520)),  # part outline
    Shape("circle", (300, 320, 40)),  # hole
    Shape("rect", (320, 705, 560, 780)),  # title block frame
)


def drawing(
    name: str, description: str, texts: tuple[str, ...],
    measurements: tuple[dict[str, Any], ...], unrecognized_extra: tuple[str, ...] = (),
) -> Fixture:  # fmt: skip
    """A plain A4 drawing: annotations at the left, a title block at the bottom right."""
    runs = annotation_runs(texts) + TITLE_RUNS
    spec = PageSpec(runs=runs, shapes=PART_SHAPES)
    return Fixture(
        name=name,
        description=description,
        doc=DocumentSpec(pages=(spec,)),
        lines=tuple(ExpectedLine(r.text, r) for r in runs),
        measurements=measurements,
        unrecognized=unrecognized_extra + TITLE_LABELS,
        page=page_meta(spec),
    )


def upright_run(text: str, vx: float, vy: float, rotate: int, w: float, h: float) -> TextRun:
    """A run that reads upright for the viewer at viewer position (vx, vy baseline).

    Inverts the clockwise /Rotate display mapping for the run's origin point and
    draws the text rotated counter-clockwise by the same angle.
    """
    x, y = {
        0: (vx, vy),
        90: (vy, h - vx),
        180: (w - vx, h - vy),
        270: (w - vy, vx),
    }[rotate]
    return TextRun(text, x, y, angle=rotate)


BASIC_TEXTS = ("THICKNESS: 4 mm", "DIAMETER: 20 mm", "LENGTH: 120 mm", "MATERIAL: SS400")


def basic_measurements(raws: tuple[str, ...] = BASIC_TEXTS) -> tuple[dict[str, Any], ...]:
    return (
        dim("M1", "thickness", raws[0], "4", "mm", "4"),
        dim("M2", "diameter", raws[1], "20", "mm", "20"),
        dim("M3", "length", raws[2], "120", "mm", "120"),
        mat("M4", raws[3], "SS400"),
    )


def rotated(
    rotate: int, crop: tuple[float, float, float, float] | None = None, *, inherit: bool = False
) -> Fixture:
    media = (0.0, 0.0, 700.0, 900.0) if crop else A4
    box = crop or media
    w, h = box[2] - box[0], box[3] - box[1]
    texts = (*BASIC_TEXTS, "TITLE: ROTATED")
    runs = tuple(upright_run(t, 72, 100 + 20 * i, rotate, w, h) for i, t in enumerate(texts))
    spec = PageSpec(media_box=media, crop_box=crop, rotate=rotate, runs=runs)
    name = f"rotated_{rotate}" if crop is None else f"cropped_rotated_{rotate}"
    if inherit:
        name = f"inherited_crop_rotated_{rotate}"
    return Fixture(
        name=name,
        description=f"/Rotate {rotate}{' with an offset CropBox' if crop else ''}"
        f"{' inherited from the page tree' if inherit else ''}; "
        "text drawn so it reads upright for the viewer.",
        doc=DocumentSpec(pages=(spec,), inherit_boxes=inherit),
        lines=tuple(ExpectedLine(r.text, r) for r in runs),
        measurements=basic_measurements(),
        unrecognized=("TITLE",),
        page=page_meta(spec),
    )


CROP = (50.0, 40.0, 645.0, 882.0)  # 595 x 842 visible area inside a 700 x 900 MediaBox


# --------------------------------------------------------------- fixtures


def _split_spans() -> Fixture:
    font_change = TextRun(
        "THICKNESS:", 72, 560, continuation=(Continuation(" 4 mm", font="Courier", size=12),)
    )
    tj_small_gap = TextRun("DIAMETER:", 72, 580, continuation=(Continuation("20 mm", gap_em=0.5),))
    tj_large_gap = TextRun("LENGTH: 120 mm", 72, 600)
    tj_large_gap_tail = Continuation("MATERIAL: SS400", gap_em=4.0)
    one_object = TextRun("LENGTH: 120 mm", 72, 600, continuation=(tj_large_gap_tail,))
    # The second annotation of the one-object run starts after a 4 em gap.
    tail_x = 72 + text_width("LENGTH: 120 mm", "Helvetica", 10) + 4.0 * 10
    tail = TextRun("MATERIAL: SS400", tail_x, 600)
    spec = PageSpec(runs=(font_change, tj_small_gap, one_object), shapes=PART_SHAPES)
    return Fixture(
        name="split_spans",
        description="Annotations split across spans: a font change mid-line, a 0.5 em TJ "
        "gap (read as a space), and two annotations in ONE text object separated by a "
        "4 em TJ gap (must become two lines).",
        doc=DocumentSpec(pages=(spec,)),
        lines=(
            ExpectedLine("THICKNESS: 4 mm", font_change),
            ExpectedLine("DIAMETER: 20 mm", tj_small_gap),
            ExpectedLine("LENGTH: 120 mm", tj_large_gap),
            ExpectedLine("MATERIAL: SS400", tail),
        ),
        measurements=basic_measurements(
            ("THICKNESS: 4 mm", "DIAMETER: 20 mm", "LENGTH: 120 mm", "MATERIAL: SS400")
        ),
        page=page_meta(spec),
    )


def _merged_adjacent() -> Fixture:
    first = TextRun("THICKNESS: 4 mm", 72, 560)
    second_x = 72 + text_width("THICKNESS: 4 mm", "Helvetica", 10) + 2.0  # 0.2 em apart
    second = TextRun("MATERIAL: SS400", second_x, 560)
    merged = TextRun(
        "THICKNESS: 4 mm", 72, 560, continuation=(Continuation("MATERIAL: SS400", gap_em=0.2),)
    )
    spec = PageSpec(runs=(first, second), shapes=PART_SHAPES)
    raw = "THICKNESS: 4 mm MATERIAL: SS400"
    return Fixture(
        name="merged_adjacent",
        description="Two separate annotations only 2 pt (0.2 em) apart on one baseline. "
        "Geometry cannot separate them from a word space, so they read as one line; the "
        "parser must flag BOTH as ambiguous rather than lose the material.",
        doc=DocumentSpec(pages=(spec,)),
        lines=(ExpectedLine(raw, merged),),
        measurements=(
            dim("M1", "thickness", raw, None, None, None, ("unsupported_syntax",)),
            mat("M2", raw, None, ("unsupported_syntax",)),
        ),
        page=page_meta(spec),
    )


def _rotated_90_sideways() -> Fixture:
    runs = annotation_runs(BASIC_TEXTS, first=200.0)
    spec = PageSpec(rotate=90, runs=runs)
    return Fixture(
        name="rotated_90_sideways",
        description="/Rotate 90 with text drawn horizontally in page space (it appears "
        "sideways to the viewer). Page-space boxes are unaffected by /Rotate.",
        doc=DocumentSpec(pages=(spec,)),
        # Viewer order for /Rotate 90 is by page-space x, then by decreasing y.
        lines=tuple(ExpectedLine(r.text, r) for r in reversed(runs)),
        measurements=(
            mat("M1", "MATERIAL: SS400", "SS400"),
            dim("M2", "length", "LENGTH: 120 mm", "120", "mm", "120"),
            dim("M3", "diameter", "DIAMETER: 20 mm", "20", "mm", "20"),
            dim("M4", "thickness", "THICKNESS: 4 mm", "4", "mm", "4"),
        ),
        page=page_meta(spec),
    )


def _cropped() -> Fixture:
    hidden = TextRun("HIDDEN: 9 mm", 100, -6)  # above the CropBox: in the MediaBox only
    runs = annotation_runs(BASIC_TEXTS) + TITLE_RUNS
    spec = PageSpec(media_box=(0.0, 0.0, 700.0, 900.0), crop_box=CROP, runs=(hidden, *runs),
                    shapes=PART_SHAPES)  # fmt: skip
    return Fixture(
        name="cropped",
        description="CropBox offset inside a larger MediaBox. Coordinates are relative to "
        "the CropBox's top-left; a line drawn outside the CropBox is hidden and dropped.",
        doc=DocumentSpec(pages=(spec,)),
        lines=tuple(ExpectedLine(r.text, r) for r in runs),
        measurements=basic_measurements(),
        unrecognized=TITLE_LABELS,
        hidden_lines=1,
        page=page_meta(spec),
    )


def _clipped_text() -> Fixture:
    clipped = TextRun("MATERIAL: S45C", 72, 700)  # outside the clip rectangle: invisible
    runs = annotation_runs(BASIC_TEXTS)
    spec = PageSpec(runs=(*runs, clipped), text_clip=(0, 0, 595, 640), shapes=PART_SHAPES)
    return Fixture(
        name="clipped_text",
        description="A clip path hides one MATERIAL line. Invisible text must not become "
        "evidence: it is dropped and counted as hidden.",
        doc=DocumentSpec(pages=(spec,)),
        lines=tuple(ExpectedLine(r.text, r) for r in runs),
        measurements=basic_measurements(),
        hidden_lines=1,
        page=page_meta(spec),
    )


def _crop_beyond_media() -> Fixture:
    runs = annotation_runs(BASIC_TEXTS)
    spec = PageSpec(media_box=A4, crop_box=(-100.0, -50.0, 495.0, 842.0), runs=runs)
    return Fixture(
        name="crop_beyond_media",
        description="CropBox reaching past the MediaBox: the visible area is their "
        "intersection (495 x 842), and coordinates start at its top-left.",
        doc=DocumentSpec(pages=(spec,)),
        lines=tuple(ExpectedLine(r.text, r) for r in runs),
        measurements=basic_measurements(),
        page=page_meta(spec),
    )


def _invisible_text() -> Fixture:
    visible = annotation_runs(BASIC_TEXTS)
    invisible = TextRun("THICKNESS: 9 mm", 72, 700, render_mode=3)  # OCR-layer style
    tiny = TextRun("DIAMETER: 99 mm", 72, 720, size=0.5)  # not legible
    spec = PageSpec(runs=(*visible, invisible, tiny), shapes=PART_SHAPES)
    return Fixture(
        name="invisible_text",
        description="Text in invisible render mode (3 Tr) and 0.5 pt text: neither is "
        "evidence; both are dropped and counted as hidden.",
        doc=DocumentSpec(pages=(spec,)),
        lines=tuple(ExpectedLine(r.text, r) for r in visible),
        measurements=basic_measurements(),
        hidden_lines=2,
        page=page_meta(spec),
    )


def _merged_title_block() -> Fixture:
    scale = TextRun("SCALE: 1:2", 330, 745)
    material_x = 330 + text_width("SCALE: 1:2", "Helvetica", 10) + 4.0  # 0.4 em apart
    material = TextRun("MATERIAL: SS400", material_x, 745)
    merged = TextRun(
        "SCALE: 1:2", 330, 745, continuation=(Continuation("MATERIAL: SS400", gap_em=0.4),)
    )
    runs = annotation_runs(BASIC_TEXTS[:3])
    spec = PageSpec(runs=(*runs, scale, material), shapes=PART_SHAPES)
    raw = "SCALE: 1:2 MATERIAL: SS400"
    return Fixture(
        name="merged_title_block",
        description="A title-block 'SCALE:' entry and 'MATERIAL:' 0.4 em apart read as one "
        "line that starts with an unsupported label; the material must stay visible "
        "(ambiguous), not disappear.",
        doc=DocumentSpec(pages=(spec,)),
        lines=(*(ExpectedLine(r.text, r) for r in runs), ExpectedLine(raw, merged)),
        measurements=(*basic_measurements()[:3], mat("M4", raw, None, ("unsupported_syntax",))),
        unrecognized=("SCALE",),
        page=page_meta(spec),
    )


def _wide_gaps() -> Fixture:
    material = TextRun("MATERIAL: AISI", 72, 560, continuation=(Continuation("304", gap_em=0.95),))
    split_unit = TextRun("THICKNESS: 4 m", 72, 580, continuation=(Continuation("m", gap_em=1.2),))
    two = TextRun(
        "LENGTH: 120 mm", 72, 600, continuation=(Continuation("DIAMETER: 20 mm", gap_em=1.5),)
    )
    near = TextRun("DIAMETER: 8 mm", 72, 620)
    far = TextRun("NOTE: X", 72 + text_width("DIAMETER: 8 mm", "Helvetica", 10) + 25.0, 620)
    drawn = TextRun("DIAMETER: 8 mm", 72, 620, continuation=(Continuation("NOTE: X", gap_em=2.5),))
    spec = PageSpec(runs=(material, split_unit, two, drawn), shapes=PART_SHAPES)
    pair = "LENGTH: 120 mm DIAMETER: 20 mm"
    return Fixture(
        name="wide_gaps",
        description="Gaps the PDF engine breaks lines at (about 0.9 em) but BlueprintIQ "
        "does not (< 2 em): a material grade split from its number, a unit split into "
        "'m' + 'm' (must never read as metres), two annotations 1.5 em apart; and a "
        "2.5 em gap that does separate two lines.",
        doc=DocumentSpec(pages=(spec,)),
        lines=(
            ExpectedLine("MATERIAL: AISI 304", material),
            ExpectedLine("THICKNESS: 4 m m", split_unit),
            ExpectedLine(pair, two),
            ExpectedLine("DIAMETER: 8 mm", near),
            ExpectedLine("NOTE: X", far),
        ),
        measurements=(
            mat("M1", "MATERIAL: AISI 304", "AISI 304"),
            dim("M2", "thickness", "THICKNESS: 4 m m", None, None, None, ("unsupported_syntax",)),
            dim("M3", "length", pair, None, None, None, ("unsupported_syntax",)),
            dim("M4", "diameter", pair, None, None, None, ("unsupported_syntax",)),
            dim("M5", "diameter", "DIAMETER: 8 mm", "8", "mm", "8"),
        ),
        unrecognized=("NOTE",),
        page=page_meta(spec),
    )


def _invalid(name: str, description: str, error: str, *pages: PageSpec) -> Fixture:
    return Fixture(name=name, description=description, doc=DocumentSpec(pages=pages), error=error)


def all_fixtures() -> tuple[Fixture, ...]:
    single = annotation_runs(("THICKNESS: 4 mm",))
    return (
        drawing("valid_basic", "All four supported annotations, valid values.", BASIC_TEXTS,
                basic_measurements()),
        drawing(
            "violations", "Parsable values that violate the demo thresholds (rules: M4).",
            ("THICKNESS: 2 mm", "DIAMETER: 65 mm", "LENGTH: 600 mm", "MATERIAL: SS400"),
            (
                dim("M1", "thickness", "THICKNESS: 2 mm", "2", "mm", "2"),
                dim("M2", "diameter", "DIAMETER: 65 mm", "65", "mm", "65"),
                dim("M3", "length", "LENGTH: 600 mm", "600", "mm", "600"),
                mat("M4", "MATERIAL: SS400", "SS400"),
            ),
        ),
        drawing(
            "missing_material", "No MATERIAL annotation.", BASIC_TEXTS[:3],
            basic_measurements()[:3],
        ),
        drawing(
            "boundary_values", "Values exactly at and just beyond demo thresholds.",
            ("THICKNESS: 3 mm", "DIAMETER: 50 mm", "DIAMETER: 50.01 mm", "LENGTH: 10 mm",
             "LENGTH: 500 mm", "MATERIAL: SS400"),
            (
                dim("M1", "thickness", "THICKNESS: 3 mm", "3", "mm", "3"),
                dim("M2", "diameter", "DIAMETER: 50 mm", "50", "mm", "50"),
                dim("M3", "diameter", "DIAMETER: 50.01 mm", "50.01", "mm", "50.01"),
                dim("M4", "length", "LENGTH: 10 mm", "10", "mm", "10"),
                dim("M5", "length", "LENGTH: 500 mm", "500", "mm", "500"),
                mat("M6", "MATERIAL: SS400", "SS400"),
            ),
        ),
        drawing(
            "unit_conversion", "Every supported unit, with exact Decimal normalization.",
            ("THICKNESS: 0.3 cm", "DIAMETER: 2 in", "LENGTH: 0.12 m", "DIAMETER: 0.12 IN",
             "LENGTH: 4.50 MM", "MATERIAL: SS400"),
            (
                dim("M1", "thickness", "THICKNESS: 0.3 cm", "0.3", "cm", "3"),
                dim("M2", "diameter", "DIAMETER: 2 in", "2", "in", "50.8"),
                dim("M3", "length", "LENGTH: 0.12 m", "0.12", "m", "120"),
                dim("M4", "diameter", "DIAMETER: 0.12 IN", "0.12", "in", "3.048"),
                dim("M5", "length", "LENGTH: 4.50 MM", "4.50", "mm", "4.50"),
                mat("M6", "MATERIAL: SS400", "SS400"),
            ),
        ),
        drawing(
            "ambiguous", "Ambiguous and unsupported annotations, plus a specification limit.",
            ("THICKNESS: 4", "DIAMETER: 2,5 mm", "LENGTH: 100 \u00b1 0.5 mm", "THICKNESS: 4 M",
             "MATERIAL: TBD", "MIN THICKNESS: 5 mm", "HARDNESS: 200 HB"),
            (
                dim("M1", "thickness", "THICKNESS: 4", "4", None, None, ("missing_unit",)),
                dim("M2", "diameter", "DIAMETER: 2,5 mm", None, "mm", None, ("decimal_comma",)),
                dim("M3", "length", "LENGTH: 100 \u00b1 0.5 mm", None, None, None,
                    ("unsupported_syntax",)),
                dim("M4", "thickness", "THICKNESS: 4 M", "4", None, None,
                    ("ambiguous_unit_case",)),
                mat("M5", "MATERIAL: TBD", None, ("missing_value",)),
            ),
            unrecognized_extra=("MIN THICKNESS", "HARDNESS"),
        ),
        drawing(
            "conflicting", "Duplicate and conflicting annotations (kept separate; M4 decides).",
            ("THICKNESS: 4 mm", "THICKNESS: 6 mm", "DIAMETER: 10 mm", "DIAMETER: 20 mm",
             "MATERIAL: SS400", "MATERIAL: S45C"),
            (
                dim("M1", "thickness", "THICKNESS: 4 mm", "4", "mm", "4"),
                dim("M2", "thickness", "THICKNESS: 6 mm", "6", "mm", "6"),
                dim("M3", "diameter", "DIAMETER: 10 mm", "10", "mm", "10"),
                dim("M4", "diameter", "DIAMETER: 20 mm", "20", "mm", "20"),
                mat("M5", "MATERIAL: SS400", "SS400"),
                mat("M6", "MATERIAL: S45C", "S45C"),
            ),
        ),
        drawing("no_annotations", "Title block only; no supported annotations.", (), ()),
        _split_spans(),
        _merged_adjacent(),
        rotated(90),
        rotated(180),
        rotated(270),
        _rotated_90_sideways(),
        _cropped(),
        rotated(90, crop=CROP),
        rotated(270, crop=CROP, inherit=True),
        _clipped_text(),
        _crop_beyond_media(),
        _invisible_text(),
        _merged_title_block(),
        _wide_gaps(),
        _invalid("multi_page", "Two pages; Phase 1 accepts one.", "TOO_MANY_PAGES",
                 PageSpec(runs=single), PageSpec(runs=single)),
        _invalid("no_text", "Vector geometry only: no text layer (like a scan).",
                 "NO_TEXT_LAYER", PageSpec(shapes=PART_SHAPES)),
        _invalid(
            "partially_visible", "An annotation crosses the CropBox edge; the visible part "
            "would read 'THICKNESS: 4' or worse, so the document is rejected.",
            "PARTIALLY_VISIBLE_TEXT",
            PageSpec(media_box=(0.0, 0.0, 700.0, 900.0), crop_box=CROP,
                     runs=(TextRun("THICKNESS: 4 mm", 560, 300),)),
        ),
        _invalid(
            "partially_clipped", "A clip path hides the end of an annotation: some of its "
            "characters are invisible although its box is on the page.",
            "PARTIALLY_VISIBLE_TEXT",
            PageSpec(text_clip=(0, 0, 150, 842), runs=(TextRun("THICKNESS: 4 mm", 100, 300),)),
        ),
        _invalid(
            "glyph_on_crop_edge", "The last glyph straddles the CropBox edge: every "
            "character counts as visible, but the box would extend off the page.",
            "PARTIALLY_VISIBLE_TEXT",
            PageSpec(media_box=(0.0, 0.0, 700.0, 900.0), crop_box=CROP,
                     runs=(TextRun("THICKNESS: 4", 529.2, 300),)),
        ),
        _invalid(
            "glyph_mostly_clipped", "A rectangular clip hides most of the last glyph; "
            "MuPDF still reports it, but a viewer shows 'THICKNESS: 4 m'.",
            "PARTIALLY_VISIBLE_TEXT",
            PageSpec(text_clip=(0, 0, 181, 842), runs=(TextRun("THICKNESS: 4 mm", 100, 300),)),
        ),
        _invalid("rotate_135", "/Rotate 135 is not a multiple of 90 (PyMuPDF reports 0).",
                 "UNSUPPORTED_GEOMETRY", PageSpec(runs=single, rotate=135)),
        _invalid("ocr_layer_only", "Only invisible (3 Tr) text, as in an OCR'd scan.",
                 "NO_TEXT_LAYER",
                 PageSpec(runs=(TextRun("THICKNESS: 4 mm", 72, 560, render_mode=3),))),
        _invalid("user_unit", "/UserUnit 2 scales the page; not supported.",
                 "UNSUPPORTED_GEOMETRY", PageSpec(runs=single, user_unit=2.0)),
        _invalid("slanted_text", "A THICKNESS label written at 45 degrees cannot be read, so "
                 "the file is refused rather than reported as inspected.",
                 "UNSUPPORTED_GEOMETRY",
                 PageSpec(runs=(*single, TextRun("THICKNESS: 9 mm", 300, 300, angle=45)))),
    )  # fmt: skip
