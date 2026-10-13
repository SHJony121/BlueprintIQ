"""A tiny, dependency-free PDF writer for synthetic test drawings.

Why hand-written: the ground truth for extraction tests must not come from the
engine under test (PyMuPDF). This writer places every text run with explicit PDF
operators at coordinates we choose, so expected text and bounding boxes follow
from the PDF specification and published font metrics alone.

Coordinates in the fixture specs are given in BlueprintIQ's canonical page space
(origin at the top-left of the CropBox, y down, points, unrotated page). The writer
converts them to PDF user space (origin bottom-left, y up):

    x_pdf = crop.x0 + x          y_pdf = crop.y1 - y

Output is byte-for-byte deterministic (no dates, no random IDs).
"""

from __future__ import annotations

import math
import zlib
from dataclasses import dataclass, field

# Published Adobe Font Metrics (AFM) advance widths, in 1/1000 em.
# Helvetica: Adobe Core14 AFM. Courier: every glyph is 600.
HELVETICA_WIDTHS: dict[str, int] = {
    " ": 278, "!": 278, '"': 355, "#": 556, "$": 556, "%": 889, "&": 667, "'": 191,
    "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
    "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
    "8": 556, "9": 556, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556,
    "@": 1015, "A": 667, "B": 667, "C": 722, "D": 722, "E": 667, "F": 611, "G": 778,
    "H": 722, "I": 278, "J": 500, "K": 667, "L": 556, "M": 833, "N": 722, "O": 778,
    "P": 667, "Q": 778, "R": 722, "S": 667, "T": 611, "U": 722, "V": 667, "W": 944,
    "X": 667, "Y": 667, "Z": 611, "[": 278, "\\": 278, "]": 278, "^": 469, "_": 556,
    "`": 333, "a": 556, "b": 556, "c": 500, "d": 556, "e": 556, "f": 278, "g": 556,
    "h": 556, "i": 222, "j": 222, "k": 500, "l": 222, "m": 833, "n": 556, "o": 556,
    "p": 556, "q": 556, "r": 333, "s": 500, "t": 278, "u": 556, "v": 500, "w": 722,
    "x": 500, "y": 500, "z": 500, "{": 334, "|": 260, "}": 334, "~": 584,
    "\u00b1": 584, "\u00d8": 778,
}  # fmt: skip

# Ink extent of Helvetica relative to the baseline, from the AFM header:
# Ascender 718, Descender -207 (1/1000 em). Courier: Ascender 629, Descender -157.
FONT_METRICS: dict[str, tuple[float, float]] = {
    "Helvetica": (0.718, 0.207),
    "Courier": (0.629, 0.157),
}


def text_width(text: str, font: str, size: float) -> float:
    """Advance width of ``text`` from published AFM metrics (not from any PDF engine)."""
    if font == "Courier":
        return 0.6 * size * len(text)
    return sum(HELVETICA_WIDTHS[ch] for ch in text) * size / 1000.0


@dataclass(frozen=True)
class Continuation:
    """Text shown right after the previous run, optionally after a horizontal gap.

    ``gap_em`` is applied with a ``TJ`` displacement, as CAD exports often do, so the
    gap exists inside a single text object rather than between two of them.
    """

    text: str
    font: str = "Helvetica"
    size: float = 10.0
    gap_em: float = 0.0


@dataclass(frozen=True)
class TextRun:
    """One text-showing operation. ``x``/``baseline`` are canonical page space."""

    text: str
    x: float
    baseline: float
    size: float = 10.0
    font: str = "Helvetica"
    angle: int = 0  # counter-clockwise degrees in PDF user space: 0, 90, 180, 270
    render_mode: int = 0  # PDF text render mode (Tr); 3 = invisible
    # Extra runs drawn on the same baseline right after this one, in the same BT
    # block (models an annotation split across spans, e.g. a font change).
    continuation: tuple[Continuation, ...] = ()

    def ink_box(self) -> tuple[float, float, float, float]:
        """Expected visible box in canonical space, from geometry and AFM metrics."""
        width = text_width(self.text, self.font, self.size)
        for part in self.continuation:
            width += part.gap_em * part.size + text_width(part.text, part.font, part.size)
        sizes = [self.size, *(part.size for part in self.continuation)]
        fonts = [self.font, *(part.font for part in self.continuation)]
        ascent = max(FONT_METRICS[f][0] * s for f, s in zip(fonts, sizes, strict=True))
        descent = max(FONT_METRICS[f][1] * s for f, s in zip(fonts, sizes, strict=True))
        rad = math.radians(self.angle)
        # Canonical space has y pointing down, so PDF's counter-clockwise angle flips.
        adv = (math.cos(rad), -math.sin(rad))
        up = (-math.sin(rad), -math.cos(rad))
        corners = [
            (self.x + t * adv[0] + s * up[0], self.baseline + t * adv[1] + s * up[1])
            for t in (0.0, width)
            for s in (-descent, ascent)
        ]
        xs = [c[0] for c in corners]
        ys = [c[1] for c in corners]
        return (min(xs), min(ys), max(xs), max(ys))


@dataclass(frozen=True)
class Shape:
    """Simple vector geometry in canonical space.

    'rect' (x0,y0,x1,y1) and 'circle' (cx,cy,r; four Beziers) as before, plus straight-line
    kinds that CAD exports use: 'line' (x0,y0,x1,y1), 'dashed' (same, dashed), 'polyline' and
    'polygon' (x,y,...; open / closed, stroked), 'fillpoly' (x,y,...; filled), 'polycircle'
    (cx,cy,r,n; closed n-gon), 'polyarc' (cx,cy,r,a0_deg,a1_deg,n; open), 'dot'
    (cx,cy,r,n; filled n-gon) and 'fused' (``subpaths`` stroked as one path).
    """

    kind: str
    coords: tuple[float, ...]
    # "fused" only: several open polylines (flat x y ... lists) stroked as ONE path.
    subpaths: tuple[tuple[float, ...], ...] = ()


@dataclass(frozen=True)
class PageSpec:
    media_box: tuple[float, float, float, float] = (0.0, 0.0, 595.0, 842.0)  # PDF user space
    crop_box: tuple[float, float, float, float] | None = None  # PDF user space
    rotate: int = 0
    runs: tuple[TextRun, ...] = ()
    shapes: tuple[Shape, ...] = ()
    user_unit: float | None = None
    # Optional clip rectangle (canonical space) applied before all text is drawn.
    text_clip: tuple[float, float, float, float] | None = None
    # Replace the generated content stream with these exact bytes (for damage tests).
    raw_content: bytes | None = None
    # Store the content stream Flate-compressed; ``flate_truncate`` keeps only the
    # first N compressed bytes (a damaged stream that still starts correctly).
    flate: bool = False
    flate_truncate: int | None = None
    # Extra raw entries for the page dictionary, e.g. b"/UserUnit /Two".
    extra_entries: bytes = b""

    @property
    def visible_box(self) -> tuple[float, float, float, float]:
        """CropBox clipped to MediaBox (PDF 32000-1, 7.7.3.3), in PDF user space."""
        m = self.media_box
        c = self.crop_box if self.crop_box is not None else m
        return (max(c[0], m[0]), max(c[1], m[1]), min(c[2], m[2]), min(c[3], m[3]))

    @property
    def width(self) -> float:
        box = self.visible_box
        return box[2] - box[0]

    @property
    def height(self) -> float:
        box = self.visible_box
        return box[3] - box[1]


@dataclass(frozen=True)
class DocumentSpec:
    pages: tuple[PageSpec, ...] = field(default_factory=lambda: (PageSpec(),))
    # Write MediaBox/CropBox of the first page on the /Pages node instead, so every
    # page inherits them (a legal and common PDF structure).
    inherit_boxes: bool = False


def _fmt(value: float) -> str:
    text = f"{value:.4f}".rstrip("0").rstrip(".")
    return text if text not in ("", "-0") else "0"


def _pdf_string(text: str) -> bytes:
    raw = text.encode("cp1252")
    raw = raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
    return b"(" + raw + b")"


def _text_ops(run: TextRun, page: PageSpec) -> bytes:
    crop = page.visible_box
    x_pdf = crop[0] + run.x
    y_pdf = crop[3] - run.baseline
    rad = math.radians(run.angle)
    a, b = round(math.cos(rad), 10), round(math.sin(rad), 10)
    font_key = {"Helvetica": "F1", "Courier": "F2"}
    parts = [
        b"BT",
        b"%d Tr" % run.render_mode,
        f"/{font_key[run.font]} {_fmt(run.size)} Tf".encode(),
        f"{_fmt(a)} {_fmt(b)} {_fmt(-b)} {_fmt(a)} {_fmt(x_pdf)} {_fmt(y_pdf)} Tm".encode(),
        _pdf_string(run.text) + b" Tj",
    ]
    for part in run.continuation:
        parts.append(f"/{font_key[part.font]} {_fmt(part.size)} Tf".encode())
        if part.gap_em:
            # A negative TJ number moves the next glyph right by n/1000 em.
            gap = _fmt(-part.gap_em * 1000).encode()
            parts.append(b"[" + gap + b" " + _pdf_string(part.text) + b"] TJ")
        else:
            parts.append(_pdf_string(part.text) + b" Tj")
    parts.append(b"ET")
    return b"\n".join(parts)


def _poly_ops(points: list[tuple[float, float]], page: PageSpec, *, close: bool, paint: str) -> str:
    crop = page.visible_box
    xy = [(crop[0] + x, crop[3] - y) for x, y in points]
    ops = [f"{_fmt(xy[0][0])} {_fmt(xy[0][1])} m"]
    ops += [f"{_fmt(x)} {_fmt(y)} l" for x, y in xy[1:]]
    if close:
        ops.append("h")
    ops.append(paint)
    return " ".join(ops)


def _pairs(coords: tuple[float, ...]) -> list[tuple[float, float]]:
    return list(zip(coords[0::2], coords[1::2], strict=True))


def _ngon(
    cx: float, cy: float, r: float, n: int, a0: float = 0.0, a1: float = 360.0
) -> list[tuple[float, float]]:
    """n vertices on a circle: a closed polygon for a full turn, else an open arc (n + 1)."""
    import math

    full = abs(a1 - a0 - 360.0) < 1e-9
    count = n if full else n + 1
    angles = [math.radians(a0 + (a1 - a0) * i / n) for i in range(count)]
    return [(cx + r * math.cos(t), cy + r * math.sin(t)) for t in angles]


def _shape_ops(shape: Shape, page: PageSpec) -> bytes:
    crop = page.visible_box
    kind = shape.kind
    c = shape.coords
    if kind in ("line", "dashed"):
        ops = _poly_ops(_pairs(c), page, close=False, paint="S")
        return (("[3 2] 0 d " + ops + " [] 0 d") if kind == "dashed" else ops).encode()
    if kind in ("polyline", "polygon", "fillpoly"):
        paint = "f" if kind == "fillpoly" else "S"
        return _poly_ops(_pairs(c), page, close=kind != "polyline", paint=paint).encode()
    if kind in ("polycircle", "dot"):
        cx, cy, r, n = c
        pts = _ngon(cx, cy, r, int(n))
        return _poly_ops(pts, page, close=True, paint="f" if kind == "dot" else "S").encode()
    if kind == "polyarc":
        cx, cy, r, a0, a1, n = c
        return _poly_ops(_ngon(cx, cy, r, int(n), a0, a1), page, close=False, paint="S").encode()
    if kind == "fused":
        parts = [_poly_ops(_pairs(sp), page, close=False, paint="") for sp in shape.subpaths]
        return (" ".join(parts) + " S").encode()
    if shape.kind == "rect":
        x0, y0, x1, y1 = shape.coords
        values = (crop[0] + x0, crop[3] - y1, x1 - x0, y1 - y0)
        return (" ".join(_fmt(v) for v in values) + " re S").encode()
    if shape.kind == "circle":
        cx, cy, r = shape.coords
        cx, cy = crop[0] + cx, crop[3] - cy
        k = 0.5523 * r  # four Bezier arcs approximating a circle
        arcs = [
            (cx + r, cy + k, cx + k, cy + r, cx, cy + r),
            (cx - k, cy + r, cx - r, cy + k, cx - r, cy),
            (cx - r, cy - k, cx - k, cy - r, cx, cy - r),
            (cx + k, cy - r, cx + r, cy - k, cx + r, cy),
        ]
        path = [f"{_fmt(cx + r)} {_fmt(cy)} m"]
        path += [" ".join(_fmt(v) for v in arc) + " c" for arc in arcs]
        return (" ".join(path) + " S").encode()
    raise ValueError(f"unknown shape {shape.kind!r}")


def build_pdf(doc: DocumentSpec) -> bytes:
    """Serialize ``doc`` to PDF 1.4 bytes with a correct cross-reference table."""
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    catalog_id = add(b"")  # placeholder, filled below
    pages_id = add(b"")
    helv_id = add(
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    )
    cour_id = add(
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"
    )

    page_ids: list[int] = []
    for page in doc.pages:
        ops = [b"0.5 w"]
        ops += [_shape_ops(s, page) for s in page.shapes]
        if page.text_clip is not None:
            clip = _shape_ops(Shape("rect", page.text_clip), page)
            ops += [b"q", clip[:-1] + b"W n"]  # replace the stroke "S" with "W n"
        ops += [_text_ops(r, page) for r in page.runs]
        if page.text_clip is not None:
            ops.append(b"Q")
        content = b"\n".join(ops)
        if page.raw_content is not None:
            content = page.raw_content
        extra = b""
        if page.flate:
            content = zlib.compress(content, 9)
            if page.flate_truncate is not None:
                content = content[: page.flate_truncate]
            extra = b" /Filter /FlateDecode"
        content_id = add(
            b"<< /Length %d%s >>\nstream\n" % (len(content), extra) + content + b"\nendstream"
        )
        entries = [
            b"/Type /Page",
            b"/Parent %d 0 R" % pages_id,
            b"/Resources << /Font << /F1 %d 0 R /F2 %d 0 R >> >>" % (helv_id, cour_id),
            b"/Contents %d 0 R" % content_id,
        ]
        if not doc.inherit_boxes:
            entries.append(b"/MediaBox [%s]" % " ".join(_fmt(v) for v in page.media_box).encode())
        if page.crop_box is not None and not doc.inherit_boxes:
            entries.append(b"/CropBox [%s]" % " ".join(_fmt(v) for v in page.crop_box).encode())
        if page.rotate:
            entries.append(b"/Rotate %d" % page.rotate)
        if page.user_unit is not None:
            entries.append(b"/UserUnit %s" % _fmt(page.user_unit).encode())
        if page.extra_entries:
            entries.append(page.extra_entries)
        page_ids.append(add(b"<< " + b" ".join(entries) + b" >>"))

    kids = b" ".join(b"%d 0 R" % pid for pid in page_ids)
    inherited = b""
    if doc.inherit_boxes:
        first = doc.pages[0]
        inherited = b" /MediaBox [%s]" % " ".join(_fmt(v) for v in first.media_box).encode()
        if first.crop_box is not None:
            inherited += b" /CropBox [%s]" % " ".join(_fmt(v) for v in first.crop_box).encode()
    objects[pages_id - 1] = b"<< /Type /Pages /Kids [%s] /Count %d%s >>" % (
        kids,
        len(page_ids),
        inherited,
    )
    objects[catalog_id - 1] = b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id

    return serialize_objects(objects, root=catalog_id)


def serialize_objects(objects: list[bytes], root: int = 1) -> bytes:
    """Serialize raw object bodies (object n = objects[n-1]) with a correct xref table.

    For tests that need structures the high-level writer does not model, such as
    Form XObjects. Stream objects must include their own ``<< /Length >> stream``.
    """
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 %d\n" % (len(objects) + 1)
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\n" % (len(objects) + 1, root)
    out += b"startxref\n%d\n%%%%EOF\n" % xref_at
    return bytes(out)


def stream(data: bytes, extra: bytes = b"") -> bytes:
    """A stream object body with a correct /Length."""
    return b"<< /Length %d %s>>\nstream\n" % (len(data), extra) + data + b"\nendstream"
