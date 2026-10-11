"""Write the synthetic drawing fixtures and their ground truth.

Usage (from backend/):  uv run python scripts/generate_fixtures.py

PDFs are produced by the dependency-free writer in tests/fixtures/synthetic_pdf.py;
ground truth comes from tests/fixtures/drawing_specs.py. Neither uses BlueprintIQ's
extraction code or PyMuPDF. Output is deterministic, and a test checks that the
committed files match what this script produces.
"""

import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from tests.fixtures.drawing_specs import all_fixtures  # noqa: E402
from tests.fixtures.synthetic_pdf import build_pdf  # noqa: E402

DRAWINGS = BACKEND / "tests" / "fixtures" / "drawings"
EXPECTED = BACKEND / "tests" / "fixtures" / "expected"


def render() -> dict[Path, bytes]:
    """All fixture files keyed by path, without touching the disk."""
    files: dict[Path, bytes] = {}
    for fixture in all_fixtures():
        files[DRAWINGS / f"{fixture.name}.pdf"] = build_pdf(fixture.doc)
        text = json.dumps(fixture.as_json(), indent=2, ensure_ascii=False) + "\n"
        files[EXPECTED / f"{fixture.name}.json"] = text.encode("utf-8")
    return files


def main() -> None:
    DRAWINGS.mkdir(parents=True, exist_ok=True)
    EXPECTED.mkdir(parents=True, exist_ok=True)
    for path, data in render().items():
        path.write_bytes(data)
        print(f"wrote {path.relative_to(BACKEND)} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
