"""Domain schemas for extracted measurements, evidence, findings, and reports.

Design rules enforced here (see docs/design/phase1-mvp-spec.md):

* Numeric quantities are ``Decimal`` and are never converted through binary float.
* Numeric dimensions and textual material annotations are different types.
* *Extraction status* (how trustworthy a read value is) and *finding status*
  (the outcome of a rule) are separate enums with no shared values.
* A pass/fail finding may only rest on ``parsed`` measurements. Uncertain input
  can at most produce ``needs_review``.

Coordinate convention: evidence boxes are in PyMuPDF page space, which is
origin top-left, y growing downward, units of PDF points (1/72 in), on the
*unrotated* page. Page numbers are 1-based.
"""

from collections import Counter
from collections.abc import Iterable
from decimal import Decimal
from enum import StrEnum
from typing import Annotated, Literal, Self

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    PlainSerializer,
    StringConstraints,
    field_validator,
    model_validator,
)

from blueprintiq.domain.units import LengthUnit, to_mm

DISCLAIMER = (
    "BlueprintIQ is an assistive engineering prototype, not certified compliance software. "
    "Findings do not guarantee engineering safety, regulatory compliance, or manufacturing "
    "correctness and must be reviewed by a qualified person."
)

# Slack, in points, when checking that a text box lies on its page. Text boxes can
# overhang the page edge by a fraction of a point; anything further is a defect.
PAGE_BOUNDS_TOLERANCE_PT = 1.0


# --------------------------------------------------------------------------- types


def _reject_float(value: object) -> object:
    if isinstance(value, bool):
        raise ValueError("bool is not a valid quantity")
    if isinstance(value, float):
        raise ValueError(
            "float is not allowed for quantities; use Decimal, int, or a numeric string"
        )
    return value


def _non_blank(value: str) -> str:
    if not value.strip():
        raise ValueError("must not be blank")
    return value


Quantity = Annotated[
    Decimal,
    BeforeValidator(_reject_float),
    Field(allow_inf_nan=False, ge=0, max_digits=30),
    # JSON: an exact string in plain notation ("0.0000001", not "1E-7"); lossless.
    PlainSerializer(lambda v: format(v, "f"), return_type=str, when_used="json"),
]
"""A non-negative, finite Decimal. Python floats and JSON numbers are rejected."""

Coordinate = Annotated[float, Field(allow_inf_nan=False)]
NonBlankStr = Annotated[str, StringConstraints(max_length=500), AfterValidator(_non_blank)]
MeasurementId = Annotated[str, StringConstraints(pattern=r"^M[1-9][0-9]*$")]
FindingId = Annotated[str, StringConstraints(pattern=r"^F[1-9][0-9]*$")]
RuleId = Annotated[str, StringConstraints(pattern=r"^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*$", max_length=64)]


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


# ------------------------------------------------------------------------ enums


class DimensionType(StrEnum):
    THICKNESS = "thickness"
    DIAMETER = "diameter"
    LENGTH = "length"


class MeasurementType(StrEnum):
    """What an annotation measures: a dimension type, or the material."""

    THICKNESS = "thickness"
    DIAMETER = "diameter"
    LENGTH = "length"
    MATERIAL = "material"


# A part has one thickness and one material; it may have several holes and
# several annotated lengths (spec section 12.B). Fixed in code, not configurable.
SINGLE_VALUED_TYPES = frozenset({MeasurementType.THICKNESS, MeasurementType.MATERIAL})


class ExtractionStatus(StrEnum):
    """How trustworthy an extracted annotation is. Not a rule outcome."""

    PARSED = "parsed"  # matched a supported format completely
    AMBIGUOUS = "ambiguous"  # label recognized, but value or unit is not trustworthy


class ExtractionIssue(StrEnum):
    MISSING_VALUE = "missing_value"
    MISSING_UNIT = "missing_unit"
    UNSUPPORTED_UNIT = "unsupported_unit"
    AMBIGUOUS_UNIT_CASE = "ambiguous_unit_case"  # e.g. "M" or "Mm": never guessed
    DECIMAL_COMMA = "decimal_comma"
    UNSUPPORTED_SYNTAX = "unsupported_syntax"


class ExtractionMethod(StrEnum):
    PDF_TEXT_LAYER = "pdf_text_layer"


class FindingStatus(StrEnum):
    """The outcome of evaluating one rule. Not an extraction status."""

    PASS = "pass"
    FAIL = "fail"
    MISSING = "missing"
    NEEDS_REVIEW = "needs_review"


class Severity(StrEnum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


# --------------------------------------------------------------------- geometry


class BBox(_Frozen):
    """Axis-aligned box in PyMuPDF page space (points, origin top-left, y down)."""

    x0: Coordinate
    y0: Coordinate
    x1: Coordinate
    y1: Coordinate

    @model_validator(mode="after")
    def _ordered(self) -> Self:
        if not (self.x0 <= self.x1 and self.y0 <= self.y1):
            raise ValueError("bounding box must satisfy x0 <= x1 and y0 <= y1")
        return self

    @property
    def width(self) -> float:
        return self.x1 - self.x0

    @property
    def height(self) -> float:
        return self.y1 - self.y0


class PageInfo(_Frozen):
    """Geometry of one page.

    ``width_pt`` x ``height_pt`` is the visible area (the CropBox) of the *unrotated*
    page; every ``BBox`` on this page lies in that space, origin at its top-left.
    ``rotation`` is the page's /Rotate value: how a viewer turns the page (clockwise)
    for display. It never changes stored boxes; see ``domain.geometry`` for viewer space.

    ``pdf_crop_box`` is the same visible area in PDF user space (origin bottom-left,
    y up), as written in the file. A PDF viewer such as PDF.js works in that space:
    ``x_pdf = pdf_crop_box[0] + x`` and ``y_pdf = pdf_crop_box[3] - y``.
    """

    page_number: int = Field(ge=1)
    width_pt: float = Field(gt=0, allow_inf_nan=False)
    height_pt: float = Field(gt=0, allow_inf_nan=False)
    rotation: Literal[0, 90, 180, 270]
    pdf_crop_box: tuple[Coordinate, Coordinate, Coordinate, Coordinate]

    @model_validator(mode="after")
    def _crop_box_matches_size(self) -> Self:
        x0, y0, x1, y1 = self.pdf_crop_box
        if not (x0 < x1 and y0 < y1):
            raise ValueError("pdf_crop_box must satisfy x0 < x1 and y0 < y1")
        tol = 0.01
        if abs((x1 - x0) - self.width_pt) > tol or abs((y1 - y0) - self.height_pt) > tol:
            raise ValueError("pdf_crop_box size does not match width_pt x height_pt")
        return self


class SourceEvidence(_Frozen):
    """Where an annotation came from. ``bbox`` is ``None`` when it is not known."""

    page_number: int = Field(ge=1)
    bbox: BBox | None = None
    raw_text: Annotated[str, StringConstraints(max_length=500), AfterValidator(_non_blank)]
    extraction_method: ExtractionMethod

    @property
    def has_coordinates(self) -> bool:
        return self.bbox is not None


# ----------------------------------------------------------------- measurements


def _check_status_and_issues(
    status: ExtractionStatus, issues: tuple[ExtractionIssue, ...], what: str
) -> None:
    if status is ExtractionStatus.PARSED and issues:
        raise ValueError(f"a parsed {what} must not have issues")
    if status is ExtractionStatus.AMBIGUOUS and not issues:
        raise ValueError(f"an ambiguous {what} needs at least one issue")


class DimensionMeasurement(_Frozen):
    """A numeric length annotation, e.g. ``THICKNESS: 4 mm``."""

    kind: Literal["dimension"] = "dimension"
    id: MeasurementId
    dimension_type: DimensionType
    value: Quantity | None
    unit: LengthUnit | None
    normalized_value_mm: Quantity | None
    status: ExtractionStatus
    issues: tuple[ExtractionIssue, ...] = ()
    source: SourceEvidence

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        _check_status_and_issues(self.status, self.issues, "dimension")
        if self.status is ExtractionStatus.PARSED:
            if self.value is None or self.unit is None or self.normalized_value_mm is None:
                raise ValueError("a parsed dimension requires value, unit and normalized_value_mm")
            if to_mm(self.value, self.unit) != self.normalized_value_mm:
                raise ValueError("normalized_value_mm does not equal value converted to mm")
        elif self.normalized_value_mm is not None:
            raise ValueError("an ambiguous dimension must not have normalized_value_mm")
        return self


class MaterialAnnotation(_Frozen):
    """A textual material specification, e.g. ``MATERIAL: SS400``. Has no number or unit."""

    kind: Literal["material"] = "material"
    id: MeasurementId
    value: Annotated[str, StringConstraints(max_length=64)] | None
    status: ExtractionStatus
    issues: tuple[ExtractionIssue, ...] = ()
    source: SourceEvidence

    @field_validator("value", mode="before")
    @classmethod
    def _normalize(cls, value: object) -> object:
        """Trim and upper-case; blank becomes ``None``. The raw text stays in ``source``."""
        if not isinstance(value, str):
            return value
        normalized = value.strip().upper()
        if not normalized.isprintable():
            raise ValueError("material must not contain control characters")
        return normalized or None

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        _check_status_and_issues(self.status, self.issues, "material")
        if self.status is ExtractionStatus.PARSED and self.value is None:
            raise ValueError("a parsed material requires a value")
        if self.status is ExtractionStatus.AMBIGUOUS and self.value is not None:
            raise ValueError("an ambiguous material must not have a value")
        return self


Measurement = Annotated[DimensionMeasurement | MaterialAnnotation, Field(discriminator="kind")]


def measurement_type(measurement: DimensionMeasurement | MaterialAnnotation) -> MeasurementType:
    if isinstance(measurement, DimensionMeasurement):
        return MeasurementType(measurement.dimension_type.value)
    return MeasurementType.MATERIAL


class UnrecognizedAnnotation(_Frozen):
    """A labeled line whose label Phase 1 does not support. Reported, never evaluated."""

    label: Annotated[str, StringConstraints(max_length=64), AfterValidator(_non_blank)]
    source: SourceEvidence


# --------------------------------------------------------------------- findings


class EvidenceRef(_Frozen):
    """Where a measurement a finding relies on was read. Copied from its source."""

    measurement_id: MeasurementId
    page_number: int = Field(ge=1)
    bbox: BBox | None  # None when the location is unknown; never invented


class Finding(_Frozen):
    """The outcome of one rule for one measurement or group of measurements."""

    id: FindingId
    rule_id: RuleId
    rule_description: NonBlankStr
    status: FindingStatus
    severity: Severity
    measurement_ids: tuple[MeasurementId, ...]
    evidence: tuple[EvidenceRef, ...]  # one per measurement id, in the same order
    expected: NonBlankStr
    actual: NonBlankStr | None
    message: NonBlankStr

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if len(set(self.measurement_ids)) != len(self.measurement_ids):
            raise ValueError("measurement_ids contains duplicates")
        if tuple(e.measurement_id for e in self.evidence) != self.measurement_ids:
            raise ValueError("evidence must list exactly the referenced measurements, in order")
        if self.status is FindingStatus.MISSING:
            if self.measurement_ids or self.actual is not None:
                raise ValueError(
                    "a missing finding must not reference measurements or an actual value"
                )
        else:
            if not self.measurement_ids:
                raise ValueError(f"a {self.status.value} finding needs at least one measurement")
            if self.actual is None:
                raise ValueError(f"a {self.status.value} finding needs an actual value")
        return self


class FindingSummary(_Frozen):
    """Counts of each outcome, kept separate on purpose."""

    passed: int = Field(ge=0)
    failed: int = Field(ge=0)
    missing: int = Field(ge=0)
    needs_review: int = Field(ge=0)

    @classmethod
    def from_findings(cls, findings: Iterable[Finding]) -> Self:
        counts = Counter(f.status for f in findings)
        return cls(
            passed=counts[FindingStatus.PASS],
            failed=counts[FindingStatus.FAIL],
            missing=counts[FindingStatus.MISSING],
            needs_review=counts[FindingStatus.NEEDS_REVIEW],
        )


# ----------------------------------------------------------------------- report


class DocumentInfo(_Frozen):
    filename: Annotated[str, StringConstraints(max_length=255), AfterValidator(_non_blank)] | None
    sha256: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$")]
    size_bytes: int = Field(gt=0)
    page_count: int = Field(ge=1)
    pages: tuple[PageInfo, ...] = Field(min_length=1)

    @field_validator("filename")
    @classmethod
    def _bare_name(cls, value: str | None) -> str | None:
        if value is not None and any(ch in value for ch in "/\\"):
            raise ValueError("filename must be a bare file name, not a path")
        return value

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.page_count != len(self.pages):
            raise ValueError("page_count does not match the number of pages")
        if [p.page_number for p in self.pages] != list(range(1, len(self.pages) + 1)):
            raise ValueError("pages must be numbered 1..n in order")
        return self


class RulesetInfo(_Frozen):
    id: NonBlankStr
    version: NonBlankStr


def _check_unique_measurement_ids(measurements: Iterable[Measurement]) -> None:
    ids = [m.id for m in measurements]
    if len(set(ids)) != len(ids):
        raise ValueError("duplicate measurement ids")


def _check_evidence_against_pages(
    document: DocumentInfo,
    measurements: Iterable[Measurement],
    unrecognized: Iterable[UnrecognizedAnnotation],
) -> None:
    """Every evidence page must exist and every box must lie on its page."""
    pages = {p.page_number: p for p in document.pages}
    sources = [(f"measurement {m.id}", m.source) for m in measurements]
    sources += [(f"annotation {a.label}", a.source) for a in unrecognized]
    for label, source in sources:
        page = pages.get(source.page_number)
        if page is None:
            raise ValueError(f"{label} references page {source.page_number}, not in document")
        box = source.bbox
        if box is None:
            continue
        tol = PAGE_BOUNDS_TOLERANCE_PT
        if (
            box.x0 < -tol
            or box.y0 < -tol
            or box.x1 > page.width_pt + tol
            or box.y1 > page.height_pt + tol
        ):
            raise ValueError(f"{label} bounding box is outside page {page.page_number} bounds")


class DrawingExtraction(_Frozen):
    """Everything read from one drawing, before any rule is evaluated.

    ``text_lines`` is the number of visible text lines read. ``hidden_text_lines``
    counts lines that exist in the file but are not visible (outside the CropBox or
    clipped); they are never used as evidence. ``skipped_lines`` counts lines the
    parser could not read (overlong or not valid Unicode).
    """

    document: DocumentInfo
    measurements: tuple[Measurement, ...]
    unrecognized_annotations: tuple[UnrecognizedAnnotation, ...]
    text_lines: int = Field(ge=0)
    hidden_text_lines: int = Field(ge=0)
    skipped_lines: int = Field(ge=0)
    angled_text_lines: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def _cross_checks(self) -> Self:
        _check_unique_measurement_ids(self.measurements)
        _check_evidence_against_pages(
            self.document, self.measurements, self.unrecognized_annotations
        )
        return self


class InspectionReport(_Frozen):
    schema_version: Literal["1.0"] = "1.0"
    document: DocumentInfo
    ruleset: RulesetInfo
    measurements: tuple[Measurement, ...]
    unrecognized_annotations: tuple[UnrecognizedAnnotation, ...]
    findings: tuple[Finding, ...]
    summary: FindingSummary
    # Visible lines written at an angle. They are not read, so when this is above zero
    # the extraction is incomplete and the findings must not be taken as a full check.
    skipped_angled_lines: int = Field(default=0, ge=0)
    processing_time_ms: float = Field(ge=0, allow_inf_nan=False)
    disclaimer: str = DISCLAIMER

    @model_validator(mode="after")
    def _cross_checks(self) -> Self:
        self._check_unique_ids()
        self._check_evidence_against_pages()
        self._check_findings_against_measurements()
        if self.summary != FindingSummary.from_findings(self.findings):
            raise ValueError("summary does not match the findings")
        return self

    def _check_unique_ids(self) -> None:
        _check_unique_measurement_ids(self.measurements)
        f_ids = [f.id for f in self.findings]
        if len(set(f_ids)) != len(f_ids):
            raise ValueError("duplicate finding ids")

    def _check_evidence_against_pages(self) -> None:
        _check_evidence_against_pages(
            self.document, self.measurements, self.unrecognized_annotations
        )

    def _check_findings_against_measurements(self) -> None:
        by_id = {m.id: m for m in self.measurements}
        for f in self.findings:
            for mid in f.measurement_ids:
                measurement = by_id.get(mid)
                if measurement is None:
                    raise ValueError(f"finding {f.id} references unknown measurement {mid}")
                ref = next(e for e in f.evidence if e.measurement_id == mid)
                if (ref.page_number, ref.bbox) != (
                    measurement.source.page_number,
                    measurement.source.bbox,
                ):
                    raise ValueError(
                        f"finding {f.id} evidence for {mid} does not match the measurement source"
                    )
                confirmed = f.status in (FindingStatus.PASS, FindingStatus.FAIL)
                if confirmed and measurement.status is ExtractionStatus.AMBIGUOUS:
                    raise ValueError(
                        f"finding {f.id} is {f.status.value} but references "
                        f"ambiguous measurement {mid}; it can only need review"
                    )


# ------------------------------------------------------------------- text input


class TextLine(_Frozen):
    """One line of text with its location: the engine-neutral input to the parser.

    Produced by a text extractor (M3: PyMuPDF text layer). ``bbox`` is ``None`` when
    the producer cannot locate the line; it is never invented.
    """

    text: str
    page_number: int = Field(ge=1)
    bbox: BBox | None = None
