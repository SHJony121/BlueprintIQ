"""Loading committed fixtures and comparing extracted boxes with ground truth."""

import json
from pathlib import Path
from typing import Any

from blueprintiq.domain.models import BBox

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
DRAWINGS = FIXTURES / "drawings"
EXPECTED = FIXTURES / "expected"

# How far a line box may extend beyond the AFM ink box. Along the writing direction
# glyph advances are exact, so the slack is tight; across it, PDF engines use font
# ascender/descender metrics that legitimately exceed the ink extent.
ALONG_TOLERANCE_PT = 1.0
ACROSS_TOLERANCE_EM = 0.5
CONTAIN_TOLERANCE_PT = 0.5


def load_expected(name: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads((EXPECTED / f"{name}.json").read_text(encoding="utf-8"))
    return data


def pdf_bytes(name: str) -> bytes:
    return (DRAWINGS / f"{name}.pdf").read_bytes()


def fixture_names(*, valid: bool) -> list[str]:
    names = sorted(p.stem for p in EXPECTED.glob("*.json"))
    return [n for n in names if ("error" not in load_expected(n)) == valid]


def box_mismatch(actual: BBox, expected_line: dict[str, Any]) -> str | None:
    """Return a description of how ``actual`` fails the ground truth, or None if it fits.

    The extracted box must (1) contain the expected ink box and (2) not exceed it by
    more than the tolerances above. Both are checked on every edge.
    """
    ix0, iy0, ix1, iy1 = expected_line["ink_box"]
    size = float(expected_line["font_size"])
    along_x = expected_line["advance_axis"] == "x"
    slack_x = ALONG_TOLERANCE_PT if along_x else ACROSS_TOLERANCE_EM * size
    slack_y = ACROSS_TOLERANCE_EM * size if along_x else ALONG_TOLERANCE_PT
    c = CONTAIN_TOLERANCE_PT
    problems = []
    if actual.x0 > ix0 + c or actual.x0 < ix0 - slack_x:
        problems.append(f"x0={actual.x0:.2f} vs ink {ix0:.2f}")
    if actual.y0 > iy0 + c or actual.y0 < iy0 - slack_y:
        problems.append(f"y0={actual.y0:.2f} vs ink {iy0:.2f}")
    if actual.x1 < ix1 - c or actual.x1 > ix1 + slack_x:
        problems.append(f"x1={actual.x1:.2f} vs ink {ix1:.2f}")
    if actual.y1 < iy1 - c or actual.y1 > iy1 + slack_y:
        problems.append(f"y1={actual.y1:.2f} vs ink {iy1:.2f}")
    return "; ".join(problems) or None
