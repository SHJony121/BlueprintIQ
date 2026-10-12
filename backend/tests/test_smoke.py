"""Smoke tests: the package and its core PDF dependency are importable."""

import pymupdf

import blueprintiq


def test_package_exposes_version() -> None:
    assert blueprintiq.__version__ == "0.1.0"


def test_pymupdf_can_create_and_read_a_pdf_in_memory() -> None:
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), "SMOKE")
    data = doc.tobytes()
    doc.close()

    reopened = pymupdf.open(stream=data, filetype="pdf")
    try:
        assert reopened.page_count == 1
        assert "SMOKE" in reopened[0].get_text()
    finally:
        reopened.close()
