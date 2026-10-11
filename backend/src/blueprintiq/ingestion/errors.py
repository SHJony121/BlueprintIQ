"""Typed reasons for refusing a document.

Each error has a stable ``code`` (for the API) and a ``message`` that is safe to show
to a user: it never contains file paths, library error text, or document content.
"""

from typing import ClassVar


class DocumentRejectedError(Exception):
    code: ClassVar[str] = "DOCUMENT_REJECTED"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class EmptyFileError(DocumentRejectedError):
    code = "EMPTY_FILE"


class FileTooLargeError(DocumentRejectedError):
    code = "FILE_TOO_LARGE"


class UnsupportedFileTypeError(DocumentRejectedError):
    code = "UNSUPPORTED_FILE_TYPE"


class InvalidPdfError(DocumentRejectedError):
    code = "INVALID_PDF"


class EncryptedPdfError(DocumentRejectedError):
    code = "ENCRYPTED_PDF"


class TooManyPagesError(DocumentRejectedError):
    code = "TOO_MANY_PAGES"


class NoTextLayerError(DocumentRejectedError):
    code = "NO_TEXT_LAYER"


class TooManyTextLinesError(DocumentRejectedError):
    code = "TOO_MANY_TEXT_LINES"


class UnsupportedGeometryError(DocumentRejectedError):
    code = "UNSUPPORTED_GEOMETRY"


class PartiallyVisibleTextError(DocumentRejectedError):
    code = "PARTIALLY_VISIBLE_TEXT"


class PageTooComplexError(DocumentRejectedError):
    code = "PAGE_TOO_COMPLEX"
