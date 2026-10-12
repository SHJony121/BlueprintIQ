"""Resource limits for one uploaded drawing."""

from dataclasses import dataclass

MIB = 1024 * 1024


@dataclass(frozen=True, slots=True)
class IngestionLimits:
    max_bytes: int = 10 * MIB  # upload size
    max_pages: int = 1  # Phase 1: single-page drawings
    max_text_lines: int = 5000  # visible text lines across the document
    # Per page, checked before the costly per-character passes (a small compressed
    # upload can expand into millions of characters).
    max_content_bytes: int = 2 * MIB  # decompressed page content streams
    max_text_chars: int = 100_000  # non-whitespace characters on the page

    def __post_init__(self) -> None:
        values = (
            self.max_bytes, self.max_pages, self.max_text_lines,
            self.max_content_bytes, self.max_text_chars,
        )  # fmt: skip
        if min(values) < 1:
            raise ValueError("ingestion limits must be positive")


DEFAULT_LIMITS = IngestionLimits()
