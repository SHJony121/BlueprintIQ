"""Builders for valid model instances, so each test states only what it varies."""

from decimal import Decimal
from typing import Any

from blueprintiq.domain.models import (
    BBox,
    DimensionMeasurement,
    DimensionType,
    DocumentInfo,
    ExtractionMethod,
    ExtractionStatus,
    Finding,
    FindingStatus,
    FindingSummary,
    InspectionReport,
    MaterialAnnotation,
    PageInfo,
    RulesetInfo,
    Severity,
    SourceEvidence,
)
from blueprintiq.domain.units import LengthUnit

SHA256 = "a" * 64


def bbox(**overrides: float) -> BBox:
    values = {"x0": 72.0, "y0": 100.0, "x1": 180.0, "y1": 112.0} | overrides
    return BBox(**values)


def evidence(raw_text: str = "THICKNESS: 4 mm", **overrides: Any) -> SourceEvidence:
    values: dict[str, Any] = {
        "page_number": 1,
        "bbox": bbox(),
        "raw_text": raw_text,
        "extraction_method": ExtractionMethod.PDF_TEXT_LAYER,
    } | overrides
    return SourceEvidence(**values)


def parsed_dimension(**overrides: Any) -> DimensionMeasurement:
    values: dict[str, Any] = {
        "id": "M1",
        "dimension_type": DimensionType.THICKNESS,
        "value": Decimal("4"),
        "unit": LengthUnit.MM,
        "normalized_value_mm": Decimal("4"),
        "status": ExtractionStatus.PARSED,
        "source": evidence(),
    } | overrides
    return DimensionMeasurement(**values)


def parsed_material(**overrides: Any) -> MaterialAnnotation:
    values: dict[str, Any] = {
        "id": "M2",
        "value": "SS400",
        "status": ExtractionStatus.PARSED,
        "source": evidence("MATERIAL: SS400"),
    } | overrides
    return MaterialAnnotation(**values)


def ambiguous_dimension(**overrides: Any) -> DimensionMeasurement:
    values: dict[str, Any] = {
        "id": "M3",
        "dimension_type": DimensionType.DIAMETER,
        "value": Decimal("20"),
        "unit": None,
        "normalized_value_mm": None,
        "status": ExtractionStatus.AMBIGUOUS,
        "issues": ("missing_unit",),
        "source": evidence("DIAMETER: 20"),
    } | overrides
    return DimensionMeasurement(**values)


def finding(**overrides: Any) -> Finding:
    values: dict[str, Any] = {
        "id": "F1",
        "rule_id": "THK-MIN-001",
        "status": FindingStatus.PASS,
        "severity": Severity.ERROR,
        "measurement_ids": ("M1",),
        "expected": ">= 3 mm",
        "actual": "4 mm",
        "message": "Thickness 4 mm meets the minimum of 3 mm.",
    } | overrides
    return Finding(**values)


def page_info(**overrides: Any) -> PageInfo:
    values: dict[str, Any] = {
        "page_number": 1,
        "width_pt": 595.0,
        "height_pt": 842.0,
        "rotation": 0,
    } | overrides
    return PageInfo(**values)


def document_info(**overrides: Any) -> DocumentInfo:
    values: dict[str, Any] = {
        "filename": "plate.pdf",
        "sha256": SHA256,
        "size_bytes": 12_345,
        "page_count": 1,
        "pages": (page_info(),),
    } | overrides
    return DocumentInfo(**values)


def report(**overrides: Any) -> InspectionReport:
    findings = overrides.pop("findings", (finding(),))
    values: dict[str, Any] = {
        "document": document_info(),
        "ruleset": RulesetInfo(id="demo", version="0.1.0"),
        "measurements": (parsed_dimension(), parsed_material()),
        "unrecognized_annotations": (),
        "findings": findings,
        "summary": FindingSummary.from_findings(findings),
        "processing_time_ms": 12.5,
    } | overrides
    return InspectionReport(**values)
