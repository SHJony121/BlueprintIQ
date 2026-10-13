"""Read visible text lines and their evidence boxes from a PDF page (layer B).

Coordinates: PyMuPDF reports text in *page space*, i.e. the visible area (CropBox)
of the unrotated page, origin top-left, y down, points. Boxes are stored exactly
as reported; /Rotate is recorded in ``PageInfo`` and only applied when a viewer
displays the page (see ``domain.geometry``).

Rules that keep evidence honest (details and rationale: spec section 15):

* **Cost first.** Before any text pass, the decoded page content and every Form
  XObject it invokes (multiplied by how often it is invoked) are measured with
  bounded decompression, and the character count is checked (``PAGE_TOO_COMPLEX``).
* **Visibility.** Text is read twice: with PyMuPDF's clipping (what a viewer shows)
  and without. Invisible render modes (alpha 0) and text below ``MIN_VISIBLE_SIZE_PT``
  count as hidden. All-hidden lines are dropped and counted; partly visible lines,
  or glyphs a clip may cut, refuse the document (``PARTIALLY_VISIBLE_TEXT``).
* **Segmentation.** Text on one baseline is joined across the engine's own line
  breaks and split only at empty gaps of at least ``GAP_SPLIT_EM`` (2 em). Smaller
  gaps read as a space, so ``THICKNESS: 4 m`` + ``m`` can never become 4 metres.
* **Geometry.** Only /Rotate multiples of 90 and text along the page axes are
  supported; /UserUnit scaling is refused (``UNSUPPORTED_GEOMETRY``).
* **Engine errors.** Any PyMuPDF exception while reading a page becomes
  ``INVALID_PDF`` with a generic message; library text is never surfaced.
"""

import re
import zlib
from collections import Counter, defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from functools import partial
from typing import Any, NamedTuple

import pymupdf

from blueprintiq.domain.geometry import page_to_viewer
from blueprintiq.domain.models import (
    PAGE_BOUNDS_TOLERANCE_PT,
    BBox,
    PageInfo,
    TextLine,
    TextWord,
)
from blueprintiq.ingestion.errors import (
    InvalidPdfError,
    PageTooComplexError,
    PartiallyVisibleTextError,
    TooManyTextLinesError,
    UnsupportedGeometryError,
)
from blueprintiq.ingestion.limits import IngestionLimits
from blueprintiq.ingestion.pdf_loader import ENGINE_ERRORS

_SIGNS = "+-" + chr(0x2212)  # plus, hyphen-minus, minus sign
GAP_SPLIT_EM = 2.0
MIN_VISIBLE_SIZE_PT = 1.0  # smaller text is not legible evidence
CLIP_TOLERANCE_ALONG_PT = 0.5  # along the writing direction: a cut glyph changes the text
CLIP_TOLERANCE_ACROSS_EM = 0.35  # across it: engine boxes include the font ascender
MAX_FORM_DEPTH = 8
_AXIS_TOLERANCE = 1e-3
# Read the glyphs that are drawn, never a /ActualText replacement: a PDF can label
# the glyph "4" as "9", and the evidence must match what a person sees.
_BASE_FLAGS = (
    pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES
) | pymupdf.TEXT_IGNORE_ACTUALTEXT
VISIBLE_TEXT_FLAGS = _BASE_FLAGS
ALL_TEXT_FLAGS = _BASE_FLAGS & ~pymupdf.TEXT_MEDIABOX_CLIP

Rect4 = tuple[float, float, float, float]
Direction = tuple[float, float]


class PositionedChar(NamedTuple):
    text: str
    bbox: Rect4  # page space
    size: float  # font size in points (1 em)


@dataclass(frozen=True, slots=True)
class PageText:
    page: PageInfo
    lines: tuple[TextLine, ...]  # in reading order as the page is displayed
    hidden_lines: int
    # Visible lines written at an angle. They are never read as evidence; the caller
    # decides whether any of them makes the document unsafe to inspect.
    angled_lines: tuple[TextLine, ...] = ()


def extract_page_text(
    doc: pymupdf.Document,
    page: pymupdf.Page,
    *,
    page_number: int,
    max_lines: int,
    limits: IngestionLimits,
) -> PageText:
    info = page_info(doc, page, page_number)
    _check_cost(doc, page, limits)
    visible = _visible_char_keys(page)
    raw = _engine(
        lambda: page.get_text("rawdict", clip=pymupdf.INFINITE_RECT(), flags=ALL_TEXT_FLAGS)
    )
    clips = _clips(page)

    hidden = 0
    angled: list[TextLine] = []
    seen: set[tuple[str, float, float]] = set()
    rows: dict[tuple[Direction, float], list[list[PositionedChar]]] = defaultdict(list)
    for block in raw["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            chars: list[tuple[PositionedChar, tuple[str, float, float], tuple[float, float]]] = []
            for span in line["spans"]:
                for c in span["chars"]:
                    key = _key(c)
                    if not c["c"].isspace():
                        if key in seen:  # same glyph drawn twice (e.g. fill + clip modes)
                            continue
                        seen.add(key)
                    char = PositionedChar(c["c"], tuple(c["bbox"]), float(span["size"]))
                    chars.append((char, key, tuple(c["origin"])))
            ink = [(ch, key, origin) for ch, key, origin in chars if not ch.text.isspace()]
            if not ink:
                continue
            shown = [key in visible for _, key, _ in ink]
            if not any(shown):
                hidden += 1
                continue
            if not all(shown):
                raise PartiallyVisibleTextError(
                    "Some text is only partly visible, so the drawing cannot be read reliably."
                )
            direction = _axis_direction(line["dir"])
            if direction is None:
                box = _union([ch for ch, _, _ in ink])
                if not _on_page(box, info):
                    raise PartiallyVisibleTextError(
                        "Some text is cut off at the edge of the visible area, so the drawing "
                        "cannot be read reliably."
                    )
                text = "".join(ch.text for ch, _, _ in chars).strip()
                angled.append(TextLine(text=text, page_number=page_number, bbox=box))
                continue
            origin = ink[0][2]
            baseline = origin[1] if direction[1] == 0 else origin[0]
            rows[(direction, round(baseline, 1))].append([ch for ch, _, _ in chars])

    lines: list[TextLine] = []
    for (direction, _), pieces in rows.items():
        for segment in split_at_gaps(_join_on_baseline(pieces, direction), direction):
            box = _union(segment)
            if not _on_page(box, info) or _cut_by_clip(segment, clips, direction):
                raise PartiallyVisibleTextError(
                    "Some text is cut off at the edge of the visible area, so the drawing "
                    "cannot be read reliably."
                )
            text = "".join(ch.text for ch in segment)
            lines.append(
                TextLine(
                    text=text,
                    page_number=page_number,
                    bbox=box,
                    words=_words(segment),
                    writing=direction,
                )
            )
            if len(lines) > max_lines:
                raise TooManyTextLinesError(
                    "The drawing has more text lines than the supported limit."
                )

    lines.sort(key=lambda tl: _reading_order(tl, info))
    return PageText(page=info, lines=tuple(lines), hidden_lines=hidden, angled_lines=tuple(angled))


# ----------------------------------------------------------------- geometry


def page_info(doc: pymupdf.Document, page: pymupdf.Page, page_number: int) -> PageInfo:
    """Page geometry, refusing cases whose evidence boxes would be misleading."""
    rotation = _rotation(doc, page)
    _check_user_unit(doc, page)
    # The visible area is read from the PDF itself (PDF 32000-1, 7.7.3.3: CropBox
    # defaults to MediaBox, both are inheritable, and CropBox is clipped to
    # MediaBox). PyMuPDF's transformation_matrix is not used: on rotated pages it
    # omits the CropBox offset (verified by the cropped_rotated_90 fixture).
    media = _page_box(doc, page.xref, "MediaBox")
    if media is None:
        raise UnsupportedGeometryError("The page has no MediaBox.")
    crop = _intersect(_page_box(doc, page.xref, "CropBox") or media, media)
    width, height = crop[2] - crop[0], crop[3] - crop[1]
    # Text coordinates are relative to the engine's visible area: page.rect is that
    # area (CropBox intersected with MediaBox), rotated; derotating it gives the
    # unrotated size. If it disagrees with the file, boxes could be shifted: refuse.
    engine = _engine(lambda: page.rect * page.derotation_matrix)
    if abs(abs(engine.width) - width) > 0.01 or abs(abs(engine.height) - height) > 0.01:
        raise UnsupportedGeometryError("The page's visible area could not be determined.")
    return PageInfo(
        page_number=page_number,
        width_pt=width,
        height_pt=height,
        rotation=rotation,
        pdf_crop_box=crop,
    )


_NUMBER = re.compile(r"[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)")
_INTEGER = re.compile(r"[-+]?[0-9]+")


def _pdf_text(doc: pymupdf.Document, kind: str, value: str) -> str:
    """A dictionary value as PDF syntax, so its type stays visible to the checks.

    PyMuPDF returns a string's content without its parentheses (``(1)`` -> ``1``),
    which would make a string look like a number; it is re-wrapped here. Indirect
    values are resolved to their object's text.
    """
    if kind == "xref":
        ref = int(value.split()[0])
        return str(_engine(lambda: doc.xref_object(ref, compressed=True))).strip()
    if kind == "string":
        return f"({value})"
    return str(value).strip()


def _inherited(doc: pymupdf.Document, page_xref: int, key: str) -> str | None:
    """The value of ``key`` on the page or its nearest /Parent ancestor, as PDF syntax.

    Returns ``None`` when no node defines the key.
    """
    xref, seen = page_xref, set()
    while xref and xref not in seen:
        seen.add(xref)
        kind, value = _engine(partial(doc.xref_get_key, xref, key))
        if kind != "null":
            return _pdf_text(doc, kind, value)
        parent_kind, parent = _engine(partial(doc.xref_get_key, xref, "Parent"))
        xref = int(parent.split()[0]) if parent_kind == "xref" else 0
    return None


def _page_box(doc: pymupdf.Document, page_xref: int, key: str) -> Rect4 | None:
    value = _inherited(doc, page_xref, key)
    if value is None:
        return None
    numbers = _NUMBER.findall(value)
    if not (value.startswith("[") and value.endswith("]")) or len(numbers) != 4:
        raise UnsupportedGeometryError(f"The page /{key} is malformed.")
    x0, y0, x1, y1 = (float(n) for n in numbers)
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _rotation(doc: pymupdf.Document, page: pymupdf.Page) -> int:
    """/Rotate read from the file. PyMuPDF silently maps e.g. 135 to 0, so it is checked."""
    value = _inherited(doc, page.xref, "Rotate")
    if value is None:
        declared = 0
    elif _INTEGER.fullmatch(value):
        declared = int(value) % 360
    else:
        raise UnsupportedGeometryError("The page /Rotate value is malformed.")
    if declared not in (0, 90, 180, 270):
        raise UnsupportedGeometryError("The page rotation is not a multiple of 90 degrees.")
    if _engine(lambda: page.rotation) != declared:
        raise UnsupportedGeometryError("The page rotation could not be determined.")
    return declared


def _check_user_unit(doc: pymupdf.Document, page: pymupdf.Page) -> None:
    kind, value = _engine(lambda: doc.xref_get_key(page.xref, "UserUnit"))
    if kind == "null":
        return
    text = _pdf_text(doc, kind, value)
    # Only a plain number is valid; strings, names and arrays are malformed.
    if not _NUMBER.fullmatch(text) or float(text) != 1.0:
        raise UnsupportedGeometryError("Pages scaled with /UserUnit are not supported.")


def _intersect(a: Rect4, b: Rect4) -> Rect4:
    box = (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))
    if box[0] >= box[2] or box[1] >= box[3]:
        raise UnsupportedGeometryError("The page's visible area is empty.")
    return box


# --------------------------------------------------------------------- cost

_DO = re.compile(rb"/([^\s/\[\]()<>{}%]+)\s+Do\b")
_REFERENCE = re.compile(r"/([^\s/\[\]()<>{}%]+)\s+([0-9]+)\s+0\s+R")


@dataclass(slots=True)
class _Budget:
    limit: int
    used: int = 0
    stack: set[int] = field(default_factory=set)

    def spend(self, amount: int) -> None:
        self.used += amount
        if self.used > self.limit:
            raise PageTooComplexError("The page content is larger than the supported limit.")


def _check_cost(doc: pymupdf.Document, page: pymupdf.Page, limits: IngestionLimits) -> None:
    """Bound the work of the text passes before running them.

    Measures the decoded page content plus every Form XObject it invokes, each
    multiplied by its number of invocations (a 3 KB file can otherwise expand into
    gigabytes through nested forms), then checks the character count.
    """
    budget = _Budget(limits.max_content_bytes)
    content = b"".join(
        _decoded(doc, xref, budget.limit - budget.used + 1) for xref in _engine(page.get_contents)
    )
    budget.spend(len(content))
    _spend_forms(doc, content, _xobjects(doc, page.xref, {}), 1, 0, budget)
    text = _engine(
        lambda: page.get_text("text", clip=pymupdf.INFINITE_RECT(), flags=ALL_TEXT_FLAGS)
    )
    if sum(not ch.isspace() for ch in text) > limits.max_text_chars:
        raise PageTooComplexError("The page has more text than the supported limit.")


def _spend_forms(
    doc: pymupdf.Document,
    content: bytes,
    names: dict[str, int],
    multiplier: int,
    depth: int,
    budget: _Budget,
) -> None:
    counts = Counter(m.group(1).decode("latin-1") for m in _DO.finditer(content))
    for name, count in counts.items():
        xref = names.get(name)
        if xref is None or not _is_form(doc, xref):
            continue
        if xref in budget.stack:
            raise InvalidPdfError("The PDF contains a form that draws itself.")
        if depth + 1 > MAX_FORM_DEPTH:
            raise PageTooComplexError("The page nests drawing objects too deeply.")
        times = multiplier * count
        data = _decoded(doc, xref, (budget.limit - budget.used) // times + 1)
        budget.spend(times * len(data))
        budget.stack.add(xref)
        _spend_forms(doc, data, _xobjects(doc, xref, names), times, depth + 1, budget)
        budget.stack.discard(xref)


def _xobjects(doc: pymupdf.Document, owner: int, fallback: dict[str, int]) -> dict[str, int]:
    """Name -> xref of the XObjects in ``owner``'s resources (inherited for pages)."""
    value = _inherited(doc, owner, "Resources/XObject")
    if value is None:
        return fallback  # a form without resources uses its parent's (PDF 1.1 behaviour)
    return {name: int(ref) for name, ref in _REFERENCE.findall(value)}


def _is_form(doc: pymupdf.Document, xref: int) -> bool:
    kind, value = _engine(lambda: doc.xref_get_key(xref, "Subtype"))
    return bool(kind == "name" and value == "/Form")


def _decoded(doc: pymupdf.Document, xref: int, budget: int) -> bytes:
    """A stream's decoded bytes, decoding at most ``budget`` bytes of Flate data."""
    raw = _engine(lambda: doc.xref_stream_raw(xref))
    if raw is None:
        raise InvalidPdfError("The PDF refers to page content that is missing.")
    kind, value = _engine(lambda: doc.xref_get_key(xref, "Filter"))
    params, _ = _engine(lambda: doc.xref_get_key(xref, "DecodeParms"))
    if kind == "null":
        return bytes(raw)
    flate = (kind == "name" and value == "/FlateDecode") or (
        kind == "array" and value.strip("[] ") == "/FlateDecode"
    )
    if flate and params == "null":
        try:
            return zlib.decompressobj().decompress(raw, max(budget, 1))
        except zlib.error:
            raise InvalidPdfError("The PDF content is damaged.") from None
    # Other filters are decoded by the engine, whose own bomb detection bounds them
    # (see spec section 15.7).
    return bytes(_engine(lambda: doc.xref_stream(xref)) or b"")


# --------------------------------------------------------------- visibility


def _key(raw_char: dict[str, Any]) -> tuple[str, float, float]:
    ox, oy = raw_char["origin"]
    return (raw_char["c"], round(float(ox), 2), round(float(oy), 2))


def _visible_char_keys(page: pymupdf.Page) -> set[tuple[str, float, float]]:
    raw = _engine(lambda: page.get_text("rawdict", flags=VISIBLE_TEXT_FLAGS))
    return {
        _key(c)
        for block in raw["blocks"]
        if block.get("type") == 0
        for line in block["lines"]
        for span in line["spans"]
        # alpha 0: invisible render modes (3 Tr, 7 Tr) or zero fill opacity.
        if span.get("alpha", 255) != 0 and float(span["size"]) >= MIN_VISIBLE_SIZE_PT
        for c in span["chars"]
        if not c["c"].isspace()
    }


class _Clip(NamedTuple):
    scissor: Rect4  # bounding box of the clip path
    rectangular: bool  # the path is exactly its bounding box


def _clips(page: pymupdf.Page) -> list[_Clip]:
    drawings = _engine(lambda: page.get_drawings(extended=True))
    return [
        _Clip(tuple(d["scissor"]), _is_rectangle(d.get("items", []), tuple(d["scissor"])))
        for d in drawings
        if d.get("type") == "clip" and d.get("scissor")
    ]


def _is_rectangle(items: Sequence[Any], scissor: Rect4) -> bool:
    """True if the path's vertices are exactly the four corners of its bounding box."""
    if [item[0] for item in items] == ["re"]:
        return True
    points: set[tuple[float, float]] = set()
    for item in items:
        if item[0] != "l":
            return False
        points.update((round(p.x, 2), round(p.y, 2)) for p in item[1:3])
    x0, y0, x1, y1 = (round(v, 2) for v in scissor)
    return points == {(x0, y0), (x1, y0), (x1, y1), (x0, y1)}


def _cut_by_clip(
    segment: Sequence[PositionedChar], clips: Sequence[_Clip], direction: Direction
) -> bool:
    """True if a clip path may hide part of any glyph.

    MuPDF keeps a glyph as visible when its box merely intersects the clip's bounding
    rectangle. For a rectangular clip, a glyph that overlaps it must lie inside it:
    tightly along the writing direction (cutting the end of a glyph changes the
    text) and within ``CLIP_TOLERANCE_ACROSS_EM`` across it (engine boxes include the
    font ascender, which carries no ink). For any other clip shape, whose coverage is
    not computed, a glyph must not overlap it at all. Conservative: every clip on the
    page is considered, whatever its scope in the content stream.
    """
    for ch in segment:
        if ch.text.isspace():
            continue
        x0, y0, x1, y1 = ch.bbox
        across = CLIP_TOLERANCE_ACROSS_EM * ch.size
        tx, ty = (
            (CLIP_TOLERANCE_ALONG_PT, across)
            if direction[1] == 0
            else (across, CLIP_TOLERANCE_ALONG_PT)
        )
        for (cx0, cy0, cx1, cy1), rectangular in clips:
            overlaps = x0 < cx1 and x1 > cx0 and y0 < cy1 and y1 > cy0
            inside = x0 >= cx0 - tx and y0 >= cy0 - ty and x1 <= cx1 + tx and y1 <= cy1 + ty
            if overlaps and (not inside or not rectangular):
                return True
    return False


# ------------------------------------------------------------- segmentation


def _join_on_baseline(
    pieces: list[list[PositionedChar]], direction: Direction
) -> list[PositionedChar]:
    """Join the engine's lines that share a baseline, in writing order.

    The engine breaks a baseline into separate lines at about 0.9 em, which could cut
    a value from its unit. Joining them and inserting a space glyph that spans each
    gap lets ``split_at_gaps`` apply BlueprintIQ's own, wider threshold.
    """

    def start(piece: list[PositionedChar]) -> float:
        return min(_interval(ch.bbox, direction)[0] for ch in piece if not ch.text.isspace())

    joined: list[PositionedChar] = []
    for piece in sorted(pieces, key=start):
        if joined:
            prev = joined[-1]
            gap_start = _interval(prev.bbox, direction)[1]
            gap_end = max(gap_start, start(piece))
            size = max(prev.size, piece[0].size)
            joined.append(
                PositionedChar(" ", _gap_box(gap_start, gap_end, prev.bbox, direction), size)
            )
        joined.extend(piece)
    return joined


def _gap_box(start: float, end: float, ref: Rect4, direction: Direction) -> Rect4:
    """A box spanning [start, end] along ``direction``, aligned with ``ref`` across it."""
    dx, dy = direction
    x0, y0, x1, y1 = ref
    if dy == 0:
        return (start, y0, end, y1) if dx > 0 else (-end, y0, -start, y1)
    return (x0, start, x1, end) if dy > 0 else (x0, -end, x1, -start)


def split_at_gaps(
    chars: Sequence[PositionedChar], direction: Direction
) -> list[list[PositionedChar]]:
    """Split characters on one baseline wherever an empty gap of >= 2 em separates them.

    ``direction`` is the axis-aligned writing direction. Whitespace characters fill
    space and never cause a split, unless a single whitespace glyph is itself at
    least ``GAP_SPLIT_EM`` wide (a stand-in for a gap). Leading and trailing
    whitespace is removed from each segment; empty segments are dropped.
    """
    segments: list[list[PositionedChar]] = []
    current: list[PositionedChar] = []
    prev_end: float | None = None
    prev_size = 0.0

    def close() -> None:
        while current and current[-1].text.isspace():
            current.pop()
        while current and current[0].text.isspace():
            current.pop(0)
        if current:
            segments.append(list(current))
        current.clear()

    for ch in chars:
        start, end = _interval(ch.bbox, direction)
        if ch.text.isspace() and end - start >= GAP_SPLIT_EM * ch.size:
            close()
            prev_end, prev_size = end, ch.size
            continue
        if prev_end is not None and start - prev_end >= GAP_SPLIT_EM * max(ch.size, prev_size):
            close()
        current.append(ch)
        prev_end, prev_size = end, ch.size
    close()
    return segments


def _interval(box: Rect4, direction: Direction) -> tuple[float, float]:
    """Start and end of a box measured along the writing direction."""
    dx, dy = direction
    x0, y0, x1, y1 = box
    if abs(dx) >= abs(dy):
        return (x0, x1) if dx > 0 else (-x1, -x0)
    return (y0, y1) if dy > 0 else (-y1, -y0)


def _axis_direction(raw_dir: Any) -> Direction | None:
    """The writing direction along an axis, or ``None`` for text at any other angle."""
    dx, dy = float(raw_dir[0]), float(raw_dir[1])
    if abs(dx) < _AXIS_TOLERANCE:
        return (0.0, 1.0 if dy > 0 else -1.0)
    if abs(dy) < _AXIS_TOLERANCE:
        return (1.0 if dx > 0 else -1.0, 0.0)
    return None


# ------------------------------------------------------------------ helpers


def _engine[T](call: Callable[[], T]) -> T:
    """Run a PyMuPDF call; any engine failure becomes a typed, generic rejection."""
    try:
        return call()
    except ENGINE_ERRORS:
        raise InvalidPdfError("A page of the PDF could not be read.") from None


def _words(segment: Sequence[PositionedChar]) -> tuple[TextWord, ...]:
    """Split a line at whitespace; each word keeps the union of its glyph boxes."""
    words: list[TextWord] = []
    current: list[PositionedChar] = []
    for ch in [*segment, None]:
        if ch is not None and not ch.text.isspace():
            current.append(ch)
            continue
        if current:
            sign = current[0].text in _SIGNS and len(current) > 1
            words.append(
                TextWord(
                    text="".join(c.text for c in current),
                    bbox=_union(current),
                    number_bbox=_union(current[1:] if sign else current),
                )
            )
            current = []
    return tuple(words)


def _union(segment: Sequence[PositionedChar]) -> BBox:
    ink = [ch.bbox for ch in segment if not ch.text.isspace()]
    return BBox(
        x0=min(b[0] for b in ink),
        y0=min(b[1] for b in ink),
        x1=max(b[2] for b in ink),
        y1=max(b[3] for b in ink),
    )


def _on_page(box: BBox, page: PageInfo) -> bool:
    tol = PAGE_BOUNDS_TOLERANCE_PT
    return (
        box.x0 >= -tol
        and box.y0 >= -tol
        and box.x1 <= page.width_pt + tol
        and box.y1 <= page.height_pt + tol
    )


def _reading_order(line: TextLine, page: PageInfo) -> tuple[float, float]:
    assert line.bbox is not None  # every extracted line has a box
    rect = page_to_viewer(line.bbox, page)
    return (round(rect.top, 1), rect.left)
