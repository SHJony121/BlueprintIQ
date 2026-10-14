"""Benchmark inputs, all synthetic: the two shipped samples, a moderately complex vector
drawing, and a drawing padded to just under the 10 MiB upload limit.

Usage: python deploy/bench/make_inputs.py <output dir>

Uses the backend's dependency-free test PDF writer; nothing here touches PyMuPDF or any real
drawing. The padded file stays a well-formed PDF (an unreferenced stream object carries the
padding, so the cross-reference table is correct and MuPDF does not need to repair it).
"""

import math
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from tests.fixtures.synthetic_pdf import (  # noqa: E402
    DocumentSpec,
    PageSpec,
    Shape,
    TextRun,
    build_pdf,
    serialize_objects,
    stream,
)

MIB = 1024 * 1024
LIMIT = 10 * MIB


def complex_drawing() -> bytes:
    """A busy single page: thousands of line segments and circles plus a few hundred notes.

    Stays inside the backend's complexity limits (it must be accepted); it is meant to cost
    more than the samples, not to be refused.
    """
    shapes: list[Shape] = [Shape("rect", (40, 40, 555, 800))]
    for i in range(1500):  # hatching and construction lines
        y = 50 + (i % 750) * 1.0
        x = 50 + (i // 750) * 250
        shapes.append(Shape("line", (x, y, x + 240, y)))
    for i in range(120):  # round features
        cx = 70 + (i % 12) * 40
        cy = 100 + (i // 12) * 70
        shapes.append(Shape("polycircle", (cx, cy, 12 + (i % 5), 48)))
    for i in range(300):  # short diagonals
        a = math.radians(i * 7)
        x, y = 300 + 200 * math.cos(a), 420 + 300 * math.sin(a)
        shapes.append(Shape("line", (300, 420, x, y)))
    runs = [
        TextRun("THICKNESS: 4 mm", 60, 60),
        TextRun("DIAMETER: 20 mm", 60, 80),
        TextRun("LENGTH: 120 mm", 60, 100),
        TextRun("MATERIAL: S235JR", 60, 120),
        TextRun("All dimensions are in millimeter", 60, 790),
    ]
    for i in range(400):
        runs.append(TextRun(f"REF NOTE {chr(65 + i % 26)}{chr(65 + (i // 26) % 26)}", 60 + (i % 4) * 130, 140 + (i // 4) * 6.4, size=5))
    return build_pdf(DocumentSpec(pages=(PageSpec(runs=tuple(runs), shapes=tuple(shapes)),)))


def heavy_drawing() -> bytes:
    """About the heaviest drawing the backend accepts: close to its text-line, character and
    line-run limits (5,000 lines, 100,000 characters, 8,000 straight runs). A worst case for
    CPU and memory that is still a valid, accepted input."""
    shapes: list[Shape] = []
    for i in range(7000):
        y = 20 + (i % 780)
        x = 20 + (i // 780) * 60
        shapes.append(Shape("line", (x, y, x + 55, y + (i % 7) * 0.5)))
    for i in range(60):
        shapes.append(Shape("polycircle", (80 + (i % 10) * 50, 100 + (i // 10) * 80, 14, 48)))
    runs = [
        TextRun("THICKNESS: 4 mm", 20, 12),
        TextRun("DIAMETER: 20 mm", 150, 12),
        TextRun("LENGTH: 120 mm", 280, 12),
        TextRun("MATERIAL: S235JR", 410, 12),
    ]
    for i in range(4700):
        runs.append(TextRun(f"NOTE {i:05d} ABCDEFGHIJ", 20 + (i % 5) * 110, 24 + (i // 5) * 0.8, size=0.7))
    return build_pdf(DocumentSpec(pages=(PageSpec(runs=tuple(runs), shapes=tuple(shapes)),)))


def padded(base: bytes, total: int) -> bytes:
    """`base` with one extra unreferenced stream object so the file is `total` bytes long."""
    # Rebuild from the base document's own objects is not possible, so wrap it: a PDF whose
    # page content is the sample, plus the padding object. Simplest correct route: reuse the
    # writer's page by building a new document and appending the object list.
    spec = DocumentSpec(
        pages=(
            PageSpec(
                runs=(
                    TextRun("THICKNESS: 4 mm", 72, 100),
                    TextRun("DIAMETER: 20 mm", 72, 120),
                    TextRun("LENGTH: 120 mm", 72, 140),
                    TextRun("MATERIAL: S235JR", 72, 160),
                ),
                shapes=(Shape("polycircle", (300, 400, 40, 64)),),
            ),
        )
    )
    small = build_pdf(spec)
    # Objects of `small` are re-serialized with the padding appended as the last object.
    objects = _objects_of(small)
    overhead = len(serialize_objects([*objects, stream(b"")])) - len(small)
    pad_len = total - len(small) - overhead - 64
    data = serialize_objects([*objects, stream(bytes(max(pad_len, 0)))])
    # Trim/grow by the small difference so the size is exact.
    return data


def _objects_of(pdf: bytes) -> list[bytes]:
    """Object bodies of a PDF written by serialize_objects (n 0 obj ... endobj, in order)."""
    bodies: list[bytes] = []
    pos = pdf.index(b"1 0 obj\n")
    number = 1
    while True:
        head = b"%d 0 obj\n" % number
        start = pdf.find(head, pos)
        if start == -1:
            break
        body_start = start + len(head)
        end = pdf.index(b"\nendobj\n", body_start)
        bodies.append(pdf[body_start:end])
        pos = end
        number += 1
    return bodies


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    samples = ROOT / "frontend" / "public" / "samples"
    shutil.copy(samples / "blueprintiq-sample-basic.pdf", out / "sample-basic.pdf")
    shutil.copy(samples / "blueprintiq-sample-cad.pdf", out / "sample-cad.pdf")
    (out / "complex.pdf").write_bytes(complex_drawing())
    (out / "heavy.pdf").write_bytes(heavy_drawing())
    near = padded(b"", LIMIT - 2048)
    (out / "near-limit.pdf").write_bytes(near)
    (out / "at-limit.pdf").write_bytes(padded(b"", LIMIT))
    (out / "over-limit.pdf").write_bytes(b"%PDF-1.4\n" + bytes(LIMIT))
    for path in sorted(out.glob("*.pdf")):
        print(f"{path.name}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
