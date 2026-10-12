"""Findings, summary, and report-level invariants."""

import json

import pytest
from pydantic import ValidationError

from blueprintiq.domain.models import (
    DISCLAIMER,
    SINGLE_VALUED_TYPES,
    EvidenceRef,
    ExtractionStatus,
    FindingStatus,
    FindingSummary,
    InspectionReport,
    MeasurementType,
    UnrecognizedAnnotation,
    measurement_type,
)
from tests.factories import (
    SHA256,
    ambiguous_dimension,
    bbox,
    document_info,
    evidence,
    finding,
    page_info,
    parsed_dimension,
    parsed_material,
    report,
)


class TestSeparateConcepts:
    def test_extraction_status_and_finding_status_share_no_values(self) -> None:
        extraction = {s.value for s in ExtractionStatus}
        outcomes = {s.value for s in FindingStatus}
        assert extraction.isdisjoint(outcomes)

    def test_finding_outcomes_are_the_four_distinct_cases(self) -> None:
        assert {s.value for s in FindingStatus} == {"pass", "fail", "missing", "needs_review"}


class TestFinding:
    def test_valid_finding(self) -> None:
        assert finding().status is FindingStatus.PASS

    def test_missing_finding_has_no_measurements_and_no_actual(self) -> None:
        f = finding(
            status=FindingStatus.MISSING,
            measurement_ids=(),
            actual=None,
            message="No thickness annotation found.",
        )
        assert f.measurement_ids == ()

    def test_missing_finding_must_not_reference_measurements(self) -> None:
        with pytest.raises(ValidationError, match="missing"):
            finding(status=FindingStatus.MISSING, actual=None)

    def test_missing_finding_must_not_report_an_actual_value(self) -> None:
        with pytest.raises(ValidationError, match="missing"):
            finding(status=FindingStatus.MISSING, measurement_ids=())

    @pytest.mark.parametrize(
        "status", [FindingStatus.PASS, FindingStatus.FAIL, FindingStatus.NEEDS_REVIEW]
    )
    def test_evaluated_finding_needs_measurements_and_actual(self, status: FindingStatus) -> None:
        with pytest.raises(ValidationError, match="measurement"):
            finding(status=status, measurement_ids=())
        with pytest.raises(ValidationError, match="actual"):
            finding(status=status, actual=None)

    @pytest.mark.parametrize("rule_id", ["", "thk-min", "THK_MIN", "-X", "THK--1"])
    def test_rule_id_format(self, rule_id: str) -> None:
        with pytest.raises(ValidationError):
            finding(rule_id=rule_id)

    @pytest.mark.parametrize("bad_id", ["", "f1", "M1", "F"])
    def test_finding_id_format(self, bad_id: str) -> None:
        with pytest.raises(ValidationError):
            finding(id=bad_id)

    def test_message_must_not_be_blank(self) -> None:
        with pytest.raises(ValidationError):
            finding(message=" ")

    def test_duplicate_measurement_ids_are_rejected(self) -> None:
        with pytest.raises(ValidationError, match="duplicate"):
            finding(measurement_ids=("M1", "M1"))


class TestFindingSummary:
    def test_from_findings_counts_each_outcome_separately(self) -> None:
        findings = (
            finding(id="F1"),
            finding(id="F2", status=FindingStatus.FAIL),
            finding(id="F3", status=FindingStatus.FAIL),
            finding(id="F4", status=FindingStatus.NEEDS_REVIEW),
            finding(id="F5", status=FindingStatus.MISSING, measurement_ids=(), actual=None),
        )
        s = FindingSummary.from_findings(findings)
        assert (s.passed, s.failed, s.missing, s.needs_review) == (1, 2, 1, 1)

    def test_empty_findings(self) -> None:
        assert FindingSummary.from_findings(()) == FindingSummary(
            passed=0, failed=0, missing=0, needs_review=0
        )

    def test_counts_cannot_be_negative(self) -> None:
        with pytest.raises(ValidationError):
            FindingSummary(passed=-1, failed=0, missing=0, needs_review=0)


class TestDocumentInfo:
    def test_valid_document(self) -> None:
        assert document_info().page_count == 1

    def test_page_count_must_match_pages(self) -> None:
        with pytest.raises(ValidationError, match="page_count"):
            document_info(page_count=2)

    def test_pages_must_be_numbered_from_one_without_gaps(self) -> None:
        with pytest.raises(ValidationError, match="numbered"):
            document_info(page_count=1, pages=(page_info(page_number=2),))

    @pytest.mark.parametrize("digest", ["", "abc", "A" * 64, "g" * 64, "a" * 63])
    def test_sha256_must_be_lowercase_hex_64(self, digest: str) -> None:
        with pytest.raises(ValidationError):
            document_info(sha256=digest)

    @pytest.mark.parametrize("name", ["../etc/passwd", "a/b.pdf", "a\\b.pdf", "C:\\x.pdf"])
    def test_filename_must_be_a_bare_name_not_a_path(self, name: str) -> None:
        with pytest.raises(ValidationError, match="path"):
            document_info(filename=name)

    def test_filename_is_optional(self) -> None:
        assert document_info(filename=None).filename is None

    def test_empty_file_is_not_a_document(self) -> None:
        with pytest.raises(ValidationError):
            document_info(size_bytes=0)


class TestInspectionReport:
    def test_valid_report(self) -> None:
        r = report()
        assert r.schema_version == "1.0"
        assert r.disclaimer == DISCLAIMER
        assert "not certified" in r.disclaimer.lower()

    def test_json_round_trip_is_lossless(self) -> None:
        r = report()
        assert InspectionReport.model_validate_json(r.model_dump_json()) == r

    def test_json_has_expected_top_level_shape(self) -> None:
        payload = json.loads(report().model_dump_json())
        assert set(payload) == {
            "schema_version",
            "document",
            "ruleset",
            "measurements",
            "unrecognized_annotations",
            "findings",
            "summary",
            "skipped_angled_lines",
            "cad_annotations",
            "cad_unit_note",
            "processing_time_ms",
            "disclaimer",
        }
        assert payload["document"]["sha256"] == SHA256
        assert payload["measurements"][0]["value"] == "4"  # Decimal serialized as a string
        assert payload["measurements"][1]["kind"] == "material"

    def test_report_without_measurements_is_valid(self) -> None:
        findings = (finding(status=FindingStatus.MISSING, measurement_ids=(), actual=None),)
        r = report(measurements=(), findings=findings)
        assert r.summary.missing == 1

    def test_duplicate_measurement_ids_are_rejected(self) -> None:
        with pytest.raises(ValidationError, match="duplicate measurement"):
            report(measurements=(parsed_dimension(), parsed_dimension()))

    def test_duplicate_finding_ids_are_rejected(self) -> None:
        with pytest.raises(ValidationError, match="duplicate finding"):
            report(findings=(finding(), finding()))

    def test_finding_must_reference_existing_measurements(self) -> None:
        with pytest.raises(ValidationError, match="unknown measurement"):
            report(findings=(finding(measurement_ids=("M99",)),))

    def test_summary_must_match_findings(self) -> None:
        wrong = FindingSummary(passed=0, failed=1, missing=0, needs_review=0)
        with pytest.raises(ValidationError, match="summary"):
            report(summary=wrong)

    def test_negative_processing_time_is_rejected(self) -> None:
        with pytest.raises(ValidationError):
            report(processing_time_ms=-1.0)


class TestEvidenceAgainstPageGeometry:
    def test_evidence_page_must_exist(self) -> None:
        m = parsed_dimension(source=evidence(page_number=2))
        with pytest.raises(ValidationError, match="page 2"):
            report(measurements=(m, parsed_material()))

    def test_bbox_inside_page_is_accepted(self) -> None:
        m = parsed_dimension(source=evidence(bbox=bbox(x0=0, y0=0, x1=595, y1=842)))
        assert report(measurements=(m,)).measurements[0].source.has_coordinates

    def test_bbox_within_tolerance_is_accepted(self) -> None:
        m = parsed_dimension(source=evidence(bbox=bbox(x1=595.5, y1=842.5)))
        report(measurements=(m,))

    @pytest.mark.parametrize(
        "overrides",
        [{"x1": 700.0}, {"y1": 900.0}, {"x0": -20.0, "x1": 100.0}, {"y0": -20.0, "y1": 10.0}],
    )
    def test_bbox_outside_page_is_rejected(self, overrides: dict[str, float]) -> None:
        m = parsed_dimension(source=evidence(bbox=bbox(**overrides)))
        with pytest.raises(ValidationError, match="outside page"):
            report(measurements=(m,))

    def test_missing_coordinates_are_allowed_and_not_checked(self) -> None:
        m = parsed_dimension(source=evidence(bbox=None))
        assert not report(measurements=(m,)).measurements[0].source.has_coordinates

    def test_unrecognized_annotation_evidence_is_checked_too(self) -> None:
        bad = UnrecognizedAnnotation(label="HARDNESS", source=evidence(page_number=3))
        with pytest.raises(ValidationError, match="page 3"):
            report(unrecognized_annotations=(bad,))


class TestUncertainInputNeverBecomesConfirmedOutcome:
    """The central safety property: ambiguous extraction cannot back pass/fail."""

    def _report_with_ambiguous(self, status: FindingStatus) -> InspectionReport:
        f = finding(
            rule_id="DIA-MAX-001", status=status, measurement_ids=("M3",), actual="20 (no unit)"
        )
        return report(measurements=(ambiguous_dimension(), parsed_material()), findings=(f,))

    @pytest.mark.parametrize("status", [FindingStatus.FAIL, FindingStatus.PASS])
    def test_confirmed_outcome_on_ambiguous_measurement_is_rejected(
        self, status: FindingStatus
    ) -> None:
        with pytest.raises(ValidationError, match="ambiguous"):
            self._report_with_ambiguous(status)

    def test_needs_review_on_ambiguous_measurement_is_accepted(self) -> None:
        r = self._report_with_ambiguous(FindingStatus.NEEDS_REVIEW)
        assert r.summary.needs_review == 1
        assert r.summary.failed == 0

    def test_confirmed_failure_on_parsed_measurement_is_accepted(self) -> None:
        f = finding(status=FindingStatus.FAIL, actual="2 mm", message="Below minimum.")
        r = report(findings=(f,))
        assert r.summary.failed == 1

    def test_one_ambiguous_among_several_blocks_a_confirmed_outcome(self) -> None:
        f = finding(status=FindingStatus.FAIL, measurement_ids=("M1", "M3"))
        with pytest.raises(ValidationError, match="ambiguous"):
            report(
                measurements=(parsed_dimension(), ambiguous_dimension(), parsed_material()),
                findings=(f,),
            )


# ------------------------------------------------ M4: explainable, evidence-backed


class TestFindingExplainability:
    def test_finding_carries_rule_description_and_evidence(self) -> None:
        f = finding()
        assert f.rule_description
        assert [e.measurement_id for e in f.evidence] == list(f.measurement_ids)

    def test_rule_description_must_not_be_blank(self) -> None:
        with pytest.raises(ValidationError):
            finding(rule_description=" ")

    def test_evidence_must_list_exactly_the_referenced_measurements(self) -> None:
        with pytest.raises(ValidationError, match="evidence"):
            finding(evidence=())
        with pytest.raises(ValidationError, match="evidence"):
            finding(
                measurement_ids=("M1",),
                evidence=(EvidenceRef(measurement_id="M2", page_number=1, bbox=bbox()),),
            )

    def test_missing_finding_has_no_evidence(self) -> None:
        f = finding(status=FindingStatus.MISSING, measurement_ids=(), actual=None)
        assert f.evidence == ()


class TestEvidenceConsistencyInReport:
    def test_evidence_matching_the_measurement_source_is_accepted(self) -> None:
        assert report().findings[0].evidence[0].bbox == bbox()

    def test_evidence_box_that_differs_from_the_source_is_rejected(self) -> None:
        wrong = EvidenceRef(measurement_id="M1", page_number=1, bbox=bbox(x0=10.0))
        with pytest.raises(ValidationError, match="evidence"):
            report(findings=(finding(evidence=(wrong,)),))

    def test_evidence_page_that_differs_from_the_source_is_rejected(self) -> None:
        m = parsed_dimension(source=evidence(bbox=None))
        wrong = EvidenceRef(measurement_id="M1", page_number=2, bbox=None)
        with pytest.raises(ValidationError, match="evidence"):
            report(
                document=document_info(page_count=2, pages=(page_info(), page_info(page_number=2))),
                measurements=(m,),
                findings=(finding(evidence=(wrong,)),),
            )

    def test_missing_coordinates_are_carried_as_none_not_invented(self) -> None:
        m = parsed_dimension(source=evidence(bbox=None))
        r = report(measurements=(m,))
        assert r.findings[0].evidence[0].bbox is None


def test_measurement_type_covers_dimensions_and_material() -> None:
    assert measurement_type(parsed_dimension()) is MeasurementType.THICKNESS
    assert measurement_type(parsed_material()) is MeasurementType.MATERIAL
    assert {t.value for t in SINGLE_VALUED_TYPES} == {"thickness", "material"}
