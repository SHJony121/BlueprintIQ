"""Validate uploaded bytes and open them as a PDF (layer A).

Checks run cheapest first: emptiness, size, then the ``%PDF-`` signature, before any
parsing. The document is opened from memory (no temporary files) and is always
closed when the ``with`` block ends.

PyMuPDF is not thread-safe. Callers must not use the returned document from more
than one thread at a time; ``extraction.reader`` serializes all PyMuPDF work.
"""

from collections.abc import Iterator
from contextlib import contextmanager

import pymupdf

from blueprintiq.ingestion.errors import (
    EmptyFileError,
    EncryptedPdfError,
    FileTooLargeError,
    InvalidPdfError,
    TooManyPagesError,
    UnsupportedFileTypeError,
)
from blueprintiq.ingestion.limits import MIB, IngestionLimits

PDF_SIGNATURE = b"%PDF-"

# Exceptions PyMuPDF raises for unreadable input. MuPDF's own error types derive
# from Exception, not RuntimeError, so they are listed explicitly.
ENGINE_ERRORS: tuple[type[Exception], ...] = (
    RuntimeError,
    ValueError,
    pymupdf.FileDataError,
    pymupdf.mupdf.FzErrorBase,
)

# MuPDF prints errors to stderr by default, sometimes quoting document content.
# Silence that; warnings are still recorded and checked by extraction.reader.
pymupdf.TOOLS.mupdf_display_errors(False)


def check_upload(data: bytes, limits: IngestionLimits) -> None:
    """Reject empty, oversized, or non-PDF bytes without parsing them."""
    if not data:
        raise EmptyFileError("The uploaded file is empty.")
    if len(data) > limits.max_bytes:
        raise FileTooLargeError(
            f"The file is {len(data)} bytes; the limit is {limits.max_bytes} bytes "
            f"({limits.max_bytes / MIB:g} MiB)."
        )
    if not data.startswith(PDF_SIGNATURE):
        raise UnsupportedFileTypeError("The file is not a PDF (it does not start with %PDF-).")


@contextmanager
def open_pdf(data: bytes, limits: IngestionLimits) -> Iterator[pymupdf.Document]:
    """Open validated PDF bytes; reject damaged, encrypted, or over-long documents."""
    check_upload(data, limits)
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except ENGINE_ERRORS:
        raise InvalidPdfError("The file could not be read as a PDF.") from None
    try:
        _validate(doc, limits)
        yield doc
    finally:
        doc.close()


def _validate(doc: pymupdf.Document, limits: IngestionLimits) -> None:
    if doc.needs_pass:
        raise EncryptedPdfError("The PDF is password-protected.")
    if doc.page_count < 1:
        raise InvalidPdfError("The PDF has no pages.")
    if doc.page_count > limits.max_pages:
        raise TooManyPagesError(
            f"The PDF has {doc.page_count} pages; at most {limits.max_pages} supported."
        )
    try:
        for index in range(doc.page_count):
            doc.load_page(index)
    except ENGINE_ERRORS:
        raise InvalidPdfError("A page of the PDF could not be read.") from None
    # MuPDF silently rebuilds broken files (bad cross-reference table, truncation).
    # A rebuilt file may not show what its author intended, so it is not evidence.
    if doc.is_repaired:
        raise InvalidPdfError("The PDF is damaged and had to be repaired to open.")
