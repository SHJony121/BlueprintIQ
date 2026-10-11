"""PDF bytes -> validated, evidence-grounded measurements (layers A + B + D).

Concurrency: PyMuPDF does not support multithreaded use. All PyMuPDF work in this
process goes through ``_PYMUPDF_LOCK``, so concurrent callers are serialized rather
than run in parallel. (M5 additionally runs this on a single worker thread.)
"""

import hashlib
import re
import threading
from dataclasses import dataclass

import pymupdf

from blueprintiq.domain.models import (
    DocumentInfo,
    DrawingExtraction,
    ExtractionMethod,
    PageInfo,
    TextLine,
)
from blueprintiq.extraction.annotation_parser import parse_lines
from blueprintiq.extraction.text_layer import extract_page_text
from blueprintiq.ingestion.errors import InvalidPdfError, NoTextLayerError
from blueprintiq.ingestion.limits import DEFAULT_LIMITS, IngestionLimits
from blueprintiq.ingestion.pdf_loader import open_pdf

_PYMUPDF_LOCK = threading.Lock()

# MuPDF warnings that do not affect the text a viewer shows. Any other warning
# (damaged streams, syntax errors, wrong lengths, ...) rejects the document: the
# list fails closed and grows only with evidence from real drawings.
_BENIGN_WARNINGS = (
    re.compile(r"syntax error: cannot find ExtGState resource '[^']*'"),
    re.compile(r"non-embedded font using identity encoding: .*"),
    re.compile(r"encountered syntax errors; page may not be correct"),
    re.compile(r"\.\.\. repeated [0-9]+ times\.\.\."),
)
_MAX_FILENAME = 255


@dataclass(frozen=True, slots=True)
class ExtractedText:
    pages: tuple[PageInfo, ...]
    lines: tuple[TextLine, ...]  # page by page, in displayed reading order
    hidden_lines: int


def extract_text(data: bytes, *, limits: IngestionLimits = DEFAULT_LIMITS) -> ExtractedText:
    """Validate the PDF and read its visible text lines with page-space boxes."""
    pages: list[PageInfo] = []
    lines: list[TextLine] = []
    hidden = 0
    with _PYMUPDF_LOCK, open_pdf(data, limits) as doc:
        pymupdf.TOOLS.reset_mupdf_warnings()
        for index in range(doc.page_count):
            result = extract_page_text(
                doc,
                doc.load_page(index),
                page_number=index + 1,
                max_lines=limits.max_text_lines - len(lines),
                limits=limits,
            )
            pages.append(result.page)
            lines.extend(result.lines)
            hidden += result.hidden_lines
        # MuPDF tolerates damaged content (e.g. a truncated compressed stream) and
        # may rebuild a broken file while reading it. Either way the text it returns
        # may not be what the author drew, so it is not evidence.
        if doc.is_repaired or damage_warnings(pymupdf.TOOLS.mupdf_warnings()):
            raise InvalidPdfError("The PDF content is damaged or malformed.")
    if not lines:
        raise NoTextLayerError(
            "The PDF has no visible text. Scanned drawings (images) are not supported."
        )
    return ExtractedText(pages=tuple(pages), lines=tuple(lines), hidden_lines=hidden)


def damage_warnings(warnings: str) -> list[str]:
    """MuPDF warning lines that may mean the text read is not what a viewer shows."""
    lines = [line.strip() for line in warnings.splitlines() if line.strip()]
    unexplained = [line for line in lines if not any(p.fullmatch(line) for p in _BENIGN_WARNINGS)]
    if unexplained:
        return unexplained
    # The summary line alone is benign only if every specific warning was benign.
    return []


def read_drawing(
    data: bytes, *, filename: str | None = None, limits: IngestionLimits = DEFAULT_LIMITS
) -> DrawingExtraction:
    """Read one drawing: validated document info plus parsed annotations with evidence."""
    text = extract_text(data, limits=limits)
    parsed = parse_lines(text.lines, method=ExtractionMethod.PDF_TEXT_LAYER)
    document = DocumentInfo(
        filename=_display_name(filename),
        sha256=hashlib.sha256(data).hexdigest(),
        size_bytes=len(data),
        page_count=len(text.pages),
        pages=text.pages,
    )
    return DrawingExtraction(
        document=document,
        measurements=parsed.measurements,
        unrecognized_annotations=parsed.unrecognized,
        text_lines=len(text.lines),
        hidden_text_lines=text.hidden_lines,
        skipped_lines=parsed.skipped_lines,
    )


def _display_name(filename: str | None) -> str | None:
    """The bare file name a client sent, without any path; never used to open files."""
    if filename is None:
        return None
    name = re.split(r"[\\/]", filename)[-1]
    name = "".join(ch for ch in name if ch.isprintable()).strip()
    return name[:_MAX_FILENAME] or None
