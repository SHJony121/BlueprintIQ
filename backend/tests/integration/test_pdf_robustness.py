"""Regressions for the M3 independent review: hostile or damaged PDFs.

Each case reproduces a finding: before the fix the PDF was accepted and could yield
wrong evidence, or a raw library exception escaped instead of a typed rejection.
"""

import re
import time
import tracemalloc
import zlib

import pytest

from blueprintiq.extraction.reader import damage_warnings, extract_text, read_drawing
from blueprintiq.ingestion.errors import (
    DocumentRejectedError,
    InvalidPdfError,
    PageTooComplexError,
    PartiallyVisibleTextError,
    UnsupportedGeometryError,
)
from blueprintiq.ingestion.limits import IngestionLimits
from tests.fixtures.synthetic_pdf import (
    DocumentSpec,
    PageSpec,
    TextRun,
    build_pdf,
    serialize_objects,
    stream,
)
from tests.integration.fixture_data import pdf_bytes

TEXT = b"BT /F1 10 Tf 1 0 0 1 100 500 Tm (THICKNESS: 4 mm) Tj ET"


def pdf(**page: object) -> bytes:
    return build_pdf(DocumentSpec(pages=(PageSpec(**page),)))  # type: ignore[arg-type]


def shift_object(data: bytes, number: int, by: int = 42) -> bytes:
    """Insert bytes before ``number 0 obj`` and fix only startxref: offsets go stale."""
    at = data.index(b"\n%d 0 obj" % number) + 1
    shifted = data[:at] + b"%" + b"x" * (by - 2) + b"\n" + data[at:]
    m = re.search(rb"startxref\n(\d+)", shifted)
    assert m is not None
    return shifted[: m.start(1)] + str(int(m.group(1)) + by).encode() + shifted[m.end(1) :]


# ------------------------------------------------------------ damaged content


DAMAGED = {
    "truncated compressed stream": lambda: pdf(
        raw_content=TEXT * 40, flate=True, flate_truncate=60
    ),
    "unknown operators": lambda: pdf(raw_content=TEXT + b" QQQ junk Zz"),
    "too deeply nested graphics state": lambda: pdf(raw_content=b"q " * 200_000 + TEXT),
}


@pytest.mark.parametrize("label", list(DAMAGED))
def test_damaged_content_is_rejected_as_invalid(label: str) -> None:
    with pytest.raises(InvalidPdfError):
        read_drawing(DAMAGED[label]())


@pytest.mark.parametrize("obj", [3, 5])  # 3 = Helvetica font (read lazily), 5 = content
def test_file_repaired_while_reading_is_rejected(obj: int) -> None:
    with pytest.raises(InvalidPdfError):
        read_drawing(shift_object(pdf_bytes("valid_basic"), obj))


def test_missing_end_text_operator_is_tolerated() -> None:
    # MuPDF raises no warning and shows the text as drawn; the reading is faithful.
    result = read_drawing(pdf(raw_content=TEXT[: -len(b" ET")]))
    assert result.measurements[0].status.value == "parsed"


def test_engine_errors_are_never_printed(capfd: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(InvalidPdfError):
        read_drawing(pdf(raw_content=TEXT + b" QQQ (secret drawing text) Tj junk"))
    out, err = capfd.readouterr()
    assert "secret" not in out + err
    assert "MuPDF" not in out + err


def test_lock_is_released_after_a_rejection() -> None:
    with pytest.raises(DocumentRejectedError):
        read_drawing(pdf(raw_content=b"q " * 200_000 + TEXT))
    assert read_drawing(pdf_bytes("valid_basic")).measurements


# ---------------------------------------------------------- what is visible


def test_actual_text_cannot_replace_the_drawn_glyphs() -> None:
    content = (
        b"BT /F1 10 Tf 100 500 Td (THICKNESS: ) Tj "
        b"/Span << /ActualText (9) >> BDC (4) Tj EMC ( mm) Tj ET"
    )
    result = read_drawing(pdf(raw_content=content))
    m = result.measurements[0]
    assert m.source.raw_text == "THICKNESS: 4 mm"
    assert str(m.value) == "4"  # type: ignore[union-attr]


@pytest.mark.parametrize(
    ("label", "clip"),
    [
        ("non-rectangular clip over the text", b"q 50 300 m 550 300 l 550 800 l h W n "),
        ("thin strip through the baseline", b"q 0 499 595 1.5 re W n "),
    ],
)
def test_clips_that_hide_part_of_the_text_are_refused(label: str, clip: bytes) -> None:
    content = clip + b"BT /F1 10 Tf 60 500 Td (THICKNESS: 9 mm) Tj ET Q"
    with pytest.raises(PartiallyVisibleTextError):
        read_drawing(pdf(raw_content=content))


def test_rectangular_clip_around_the_whole_page_is_fine() -> None:
    content = b"q 0 0 595 842 re W n " + TEXT + b" Q"
    assert read_drawing(pdf(raw_content=content)).measurements


# ------------------------------------------------------------------ geometry


@pytest.mark.parametrize(
    "entry", [b"/UserUnit /Two", b"/UserUnit 2", b"/UserUnit (1)", b"/UserUnit [1 1]"]
)
def test_bad_or_scaling_user_unit_is_unsupported(entry: bytes) -> None:
    with pytest.raises(UnsupportedGeometryError):
        read_drawing(pdf(runs=(TextRun("THICKNESS: 4 mm", 72, 300),), extra_entries=entry))


def test_user_unit_of_one_is_accepted() -> None:
    data = pdf(runs=(TextRun("THICKNESS: 4 mm", 72, 300),), extra_entries=b"/UserUnit 1")
    assert read_drawing(data).measurements


@pytest.mark.parametrize("entry", [b"/Rotate (90)", b"/Rotate /Ninety", b"/Rotate 90.5"])
def test_rotate_that_is_not_an_integer_is_malformed(entry: bytes) -> None:
    with pytest.raises(UnsupportedGeometryError):
        read_drawing(pdf(runs=(TextRun("THICKNESS: 4 mm", 72, 300),), extra_entries=entry))


def test_rotate_written_as_an_integral_real_is_read_as_that_integer() -> None:
    # "90.0" denotes exactly 90; MuPDF and viewers agree, so evidence is unaffected.
    data = pdf(runs=(TextRun("THICKNESS: 4 mm", 72, 300),), extra_entries=b"/Rotate 90.0")
    assert extract_text(data).pages[0].rotation == 90


@pytest.mark.parametrize("rotate", [45, 91, 135, 225, 359])
def test_rotation_not_a_multiple_of_90_is_unsupported(rotate: int) -> None:
    with pytest.raises(UnsupportedGeometryError):
        read_drawing(pdf(runs=(TextRun("THICKNESS: 4 mm", 72, 300),), rotate=rotate))


@pytest.mark.parametrize(("rotate", "normalized"), [(-90, 270), (450, 90), (360, 0), (-180, 180)])
def test_equivalent_rotations_are_normalized(rotate: int, normalized: int) -> None:
    text = extract_text(pdf(runs=(TextRun("THICKNESS: 4 mm", 72, 300),), rotate=rotate))
    assert text.pages[0].rotation == normalized


def test_tiny_float_slop_in_crop_box_is_accepted() -> None:
    data = pdf(crop_box=(0.0, 0.0, 595.0, 842.02), runs=(TextRun("THICKNESS: 4 mm", 72, 300),))
    page = extract_text(data).pages[0]
    assert page.height_pt == pytest.approx(842.0)


# ----------------------------------------------------------------------- cost


def test_compression_bomb_is_refused_before_text_extraction() -> None:
    # About 20 KB compressed, over 2 MiB of text content once decompressed.
    line = b"BT /F1 1 Tf 1 0 0 1 20 400 Tm (" + b"X" * 1000 + b") Tj ET\n"
    data = pdf(raw_content=line * 2200, flate=True)
    assert len(data) < 50_000
    with pytest.raises(PageTooComplexError):
        read_drawing(data)


def test_content_size_limit_is_configurable() -> None:
    data = pdf_bytes("valid_basic")
    with pytest.raises(PageTooComplexError):
        read_drawing(data, limits=IngestionLimits(max_content_bytes=100))


def test_character_limit_is_enforced() -> None:
    data = pdf_bytes("valid_basic")
    with pytest.raises(PageTooComplexError):
        read_drawing(data, limits=IngestionLimits(max_text_chars=50))
    assert read_drawing(data, limits=IngestionLimits(max_text_chars=200)).measurements


# ------------------------------------------- second review round (re-verification)

FONT = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"


def forms_pdf(depth: int, fanout: int, leaf: bytes, *, cycle: bool = False) -> bytes:
    """Page -> /Z Do -> nested Form XObjects (each drawing its child ``fanout`` times)."""
    form_extra = b"/Type /XObject /Subtype /Form /BBox [0 0 595 842] "
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font "
        b"<< /F1 4 0 R >> /XObject << /Z 6 0 R >> >> /Contents 5 0 R >>",
        FONT,
        stream(b"/Z Do"),
    ]
    for level in range(depth):
        xref = 6 + level
        child = xref if cycle else xref + 1
        if level < depth - 1 or cycle:
            resources = b"/Resources << /Font << /F1 4 0 R >> /XObject << /Y %d 0 R >> >> " % child
            objects.append(stream(b"/Y Do\n" * fanout, form_extra + resources))
        else:
            objects.append(stream(leaf, form_extra + b"/Resources << /Font << /F1 4 0 R >> >> "))
    return serialize_objects(objects)


def test_text_inside_a_form_xobject_is_read() -> None:
    result = read_drawing(forms_pdf(2, 1, TEXT))
    assert [m.source.raw_text for m in result.measurements] == ["THICKNESS: 4 mm"]


def test_nested_form_bomb_is_refused_before_any_text_pass() -> None:
    leaf = b"BT /F1 1 Tf 1 0 0 1 20 400 Tm (" + b"X" * 1000 + b") Tj ET"
    data = forms_pdf(5, 10, leaf)  # 10,000 invocations of a 1 KB form
    assert len(data) < 5_000
    started = time.perf_counter()
    with pytest.raises(PageTooComplexError):
        read_drawing(data)
    assert time.perf_counter() - started < 5.0


def test_form_that_draws_itself_is_invalid() -> None:
    with pytest.raises(InvalidPdfError):
        read_drawing(forms_pdf(1, 1, TEXT, cycle=True))


def test_form_nesting_depth_is_limited() -> None:
    with pytest.raises(PageTooComplexError):
        read_drawing(forms_pdf(12, 1, TEXT))


@pytest.mark.parametrize("contents", [b"/Contents 5 0 R", b"/Contents [5 0 R]"])
def test_content_entry_that_is_not_a_stream_is_invalid(contents: bytes) -> None:
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " + contents + b" >>",
        FONT,
        b"null",
    ]
    with pytest.raises(InvalidPdfError):
        read_drawing(serialize_objects(objects))


def _single_content_pdf(content_stream: bytes) -> bytes:
    return serialize_objects(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            FONT,
            content_stream,
        ]
    )


def test_flate_filter_given_as_an_array_is_bounded() -> None:
    bomb = zlib.compress(TEXT + b" " * (60 * 1024 * 1024), 9)
    data = _single_content_pdf(stream(bomb, b"/Filter [/FlateDecode] "))
    tracemalloc.start()
    try:
        with pytest.raises(PageTooComplexError):
            read_drawing(data)
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    # Bounded decompression: never the 60 MiB the stream expands to.
    assert peak < 16 * 1024 * 1024


def test_line_mixing_visible_and_invisible_glyphs_is_refused() -> None:
    # "THICKNESS: 4 m" visible, the final "m" in invisible mode: a viewer shows 4 m.
    content = b"BT /F1 10 Tf 1 0 0 1 100 500 Tm (THICKNESS: 4 m) Tj 3 Tr (m) Tj ET"
    with pytest.raises(PartiallyVisibleTextError):
        read_drawing(pdf(raw_content=content))


def test_engine_bomb_detector_error_becomes_a_typed_rejection() -> None:
    # ASCIIHex + Flate is decoded by MuPDF itself, whose bomb detector raises its own
    # error type (not a RuntimeError); it must still become a typed rejection.
    bomb = zlib.compress(TEXT + b" " * (100 * 1024 * 1024), 9).hex().encode() + b">"
    data = _single_content_pdf(stream(bomb, b"/Filter [/ASCIIHexDecode /FlateDecode] "))
    with pytest.raises(DocumentRejectedError):
        read_drawing(data)


def test_glyph_drawn_with_fill_and_clip_modes_counts_once() -> None:
    content = b"BT 4 Tr /F1 10 Tf 1 0 0 1 100 500 Tm (DIAMETER: 20 mm) Tj ET"
    result = read_drawing(pdf(raw_content=content))
    assert len(result.measurements) == 1


@pytest.mark.parametrize(
    "clip",
    [
        b"q 0 0 m 595 0 l 595 842 l 0 842 l W n ",  # page rectangle, not closed with h
        b"q 98.5 496.4 90.8 12.3 re W n ",  # tight cell: 1.5 pt around the ink
    ],
)
def test_legitimate_clips_are_accepted(clip: bytes) -> None:
    assert read_drawing(pdf(raw_content=clip + TEXT + b" Q")).measurements


def test_missing_extgstate_resource_is_tolerated() -> None:
    assert read_drawing(pdf(raw_content=b"/GS9 gs " + TEXT)).measurements


@pytest.mark.parametrize(
    ("warnings", "damaged"),
    [
        ("", False),
        ("non-embedded font using identity encoding: SimSun (mapping via Adobe-GB1-UCS2)", False),
        (
            "syntax error: cannot find ExtGState resource 'GS9'\n"
            "encountered syntax errors; page may not be correct",
            False,
        ),
        ("premature end of data in flate filter\n... repeated 2 times...", True),
        (
            "syntax error: unknown keyword: 'QQQ'\n"
            "encountered syntax errors; page may not be correct",
            True,
        ),
        ("some warning nobody has seen before", True),  # fails closed
    ],
)
def test_warning_policy_fails_closed_with_a_small_allow_list(warnings: str, damaged: bool) -> None:
    assert bool(damage_warnings(warnings)) is damaged
