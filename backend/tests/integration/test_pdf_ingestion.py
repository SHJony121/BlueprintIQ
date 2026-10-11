"""Upload validation and PDF rejection: every refusal is explicit and typed."""

import pymupdf
import pytest

from blueprintiq.extraction.reader import extract_text, read_drawing
from blueprintiq.ingestion.errors import (
    DocumentRejectedError,
    EmptyFileError,
    EncryptedPdfError,
    FileTooLargeError,
    InvalidPdfError,
    NoTextLayerError,
    TooManyPagesError,
    TooManyTextLinesError,
    UnsupportedFileTypeError,
)
from blueprintiq.ingestion.limits import DEFAULT_LIMITS, IngestionLimits
from tests.fixtures.synthetic_pdf import DocumentSpec, PageSpec, TextRun, build_pdf
from tests.integration.fixture_data import pdf_bytes

VALID = pdf_bytes("valid_basic")


def _encrypt(data: bytes, *, user_pw: str) -> bytes:
    # Encryption is produced at test time; these PDFs only test rejection.
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        return doc.tobytes(
            encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw=user_pw
        )


def test_default_limits_match_the_specification() -> None:
    expected = IngestionLimits(
        max_bytes=10 * 1024 * 1024,
        max_pages=1,
        max_text_lines=5000,
        max_content_bytes=2 * 1024 * 1024,
        max_text_chars=100_000,
    )
    assert expected == DEFAULT_LIMITS


@pytest.mark.parametrize(
    ("data", "error", "code"),
    [
        (b"", EmptyFileError, "EMPTY_FILE"),
        (b"hello, this is not a pdf", UnsupportedFileTypeError, "UNSUPPORTED_FILE_TYPE"),
        (b"\x89PNG\r\n\x1a\n" + b"\x00" * 64, UnsupportedFileTypeError, "UNSUPPORTED_FILE_TYPE"),
        (b" %PDF-1.4 leading space", UnsupportedFileTypeError, "UNSUPPORTED_FILE_TYPE"),
        (b"%PDF-1.4\n garbage that is not a pdf", InvalidPdfError, "INVALID_PDF"),
        (VALID[: len(VALID) // 2], InvalidPdfError, "INVALID_PDF"),  # truncated
        (
            VALID.replace(b"startxref\n", b"startxref\n9"),
            InvalidPdfError,
            "INVALID_PDF",
        ),  # bad xref
    ],
)
def test_bad_bytes_are_rejected(data: bytes, error: type[DocumentRejectedError], code: str) -> None:
    with pytest.raises(error) as excinfo:
        read_drawing(data)
    assert excinfo.value.code == code


def test_password_protected_pdf_is_rejected() -> None:
    with pytest.raises(EncryptedPdfError):
        read_drawing(_encrypt(VALID, user_pw="secret"))


def test_owner_password_only_pdf_opens_without_a_password_and_is_accepted() -> None:
    # Permissions-only encryption: the content is readable by anyone, so it is not
    # "password protected" in the sense of the specification (documented decision).
    result = read_drawing(_encrypt(VALID, user_pw=""))
    assert len(result.measurements) == 4


def test_upload_limit_is_enforced_before_parsing() -> None:
    limits = IngestionLimits(max_bytes=len(VALID) - 1)
    with pytest.raises(FileTooLargeError) as excinfo:
        read_drawing(VALID, limits=limits)
    assert "MiB" in excinfo.value.message or "bytes" in excinfo.value.message


def test_upload_exactly_at_the_limit_is_accepted() -> None:
    assert read_drawing(VALID, limits=IngestionLimits(max_bytes=len(VALID))).measurements


def test_default_upload_limit_is_ten_mebibytes() -> None:
    too_big = b"%PDF-" + b"\x00" * (10 * 1024 * 1024 - 4)
    assert len(too_big) == 10 * 1024 * 1024 + 1
    with pytest.raises(FileTooLargeError):
        read_drawing(too_big)


def test_page_limit_is_configurable() -> None:
    two_pages = pdf_bytes("multi_page")
    with pytest.raises(TooManyPagesError):
        read_drawing(two_pages)
    result = read_drawing(two_pages, limits=IngestionLimits(max_pages=2))
    assert result.document.page_count == 2
    assert [m.source.page_number for m in result.measurements] == [1, 2]


def _many_lines(count: int) -> bytes:
    runs = tuple(
        TextRun("X", x=20 + 30 * (i % 18), baseline=10 + 3 * (i // 18), size=2.0)
        for i in range(count)
    )
    return build_pdf(DocumentSpec(pages=(PageSpec(runs=runs),)))


def test_text_line_limit_is_enforced() -> None:
    with pytest.raises(TooManyTextLinesError):
        extract_text(_many_lines(11), limits=IngestionLimits(max_text_lines=10))
    assert len(extract_text(_many_lines(10), limits=IngestionLimits(max_text_lines=10)).lines) == 10


def test_default_text_line_limit_is_five_thousand() -> None:
    with pytest.raises(TooManyTextLinesError):
        extract_text(_many_lines(5001))
    assert len(extract_text(_many_lines(5000)).lines) == 5000


def test_page_without_text_is_rejected_as_no_text_layer() -> None:
    with pytest.raises(NoTextLayerError):
        read_drawing(pdf_bytes("no_text"))


def test_rejection_messages_do_not_leak_internals() -> None:
    cases = [b"", b"nope", b"%PDF-1.4 junk", VALID[:300], _encrypt(VALID, user_pw="x")]
    for data in cases:
        with pytest.raises(DocumentRejectedError) as excinfo:
            read_drawing(data)
        message = excinfo.value.message
        assert message and "\\" not in message and "/" not in message.replace("PDF/", "")
        assert "Traceback" not in message and "mupdf" not in message.lower()
