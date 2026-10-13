// Builders for report objects used by UI-state tests. They are typed with the generated
// API types, so a backend schema change breaks the build here first. These are test
// data, not backend output; tests that need real backend responses use the real server
// (tests/ui/real-responses.test.tsx).
import { MAX_UPLOAD_BYTES } from "@/lib/limits";
import { DEMO_FORM, parseRequirements, type ParsedRequirements } from "@/inspection/requirements";
import type {
  BBox,
  DimensionMeasurement,
  Finding,
  FindingStatus,
  InspectionReport,
  MaterialAnnotation,
  Measurement,
  SourceEvidence,
} from "@/api/types";

export const REQUEST_ID = "0123456789abcdef0123456789abcdef";

export function box(overrides: Partial<BBox> = {}): BBox {
  return { x0: 72, y0: 549.3, x1: 159.8, y1: 563, ...overrides };
}

export function source(rawText: string, overrides: Partial<SourceEvidence> = {}): SourceEvidence {
  return {
    page_number: 1,
    bbox: box(),
    raw_text: rawText,
    extraction_method: "pdf_text_layer",
    ...overrides,
  };
}

export function dimension(overrides: Partial<DimensionMeasurement> = {}): DimensionMeasurement {
  return {
    kind: "dimension",
    id: "M1",
    dimension_type: "thickness",
    value: "4",
    unit: "mm",
    normalized_value_mm: "4",
    status: "parsed",
    issues: [],
    source: source("THICKNESS: 4 mm"),
    ...overrides,
  };
}

export function material(overrides: Partial<MaterialAnnotation> = {}): MaterialAnnotation {
  return {
    kind: "material",
    id: "M4",
    value: "SS400",
    status: "parsed",
    issues: [],
    source: source("MATERIAL: SS400"),
    ...overrides,
  };
}

/** A dimension whose unit was not trustworthy: nothing is guessed, so no value and no mm. */
export function ambiguousDimension(overrides: Partial<DimensionMeasurement> = {}): DimensionMeasurement {
  return dimension({
    id: "M2",
    dimension_type: "length",
    value: "12",
    unit: null,
    normalized_value_mm: null,
    status: "ambiguous",
    issues: ["ambiguous_unit_case"],
    source: source("LENGTH: 12 M", { bbox: null }),
    ...overrides,
  });
}

export function finding(
  status: FindingStatus,
  overrides: Partial<Finding> = {},
): Finding {
  const measurementIds = overrides.measurement_ids ?? (status === "missing" ? [] : ["M1"]);
  return {
    id: "F1",
    rule_id: "THK-MIN-001",
    rule_description: "Plate thickness must be at least 3 mm (demonstration value).",
    status,
    severity: "error",
    measurement_ids: measurementIds,
    evidence: measurementIds.map((id) => ({ measurement_id: id, page_number: 1, bbox: box() })),
    expected: ">= 3 mm",
    actual: status === "missing" ? null : "4 mm",
    message: "Thickness 4 mm meets the configured limit (>= 3 mm).",
    ...overrides,
  };
}

interface ReportParts {
  measurements?: Measurement[];
  findings?: Finding[];
  overrides?: Partial<InspectionReport>;
}

/** A consistent report: the summary is computed from the findings, as the backend does. */
export function makeReport({ measurements, findings, overrides }: ReportParts = {}): InspectionReport {
  const ms = measurements ?? [dimension()];
  const fs = findings ?? [finding("pass")];
  const count = (status: FindingStatus) => fs.filter((f) => f.status === status).length;
  return {
    schema_version: "1.0",
    document: {
      filename: "bracket.pdf",
      sha256: "a".repeat(64),
      size_bytes: 1319,
      page_count: 1,
      pages: [
        {
          page_number: 1,
          width_pt: 595,
          height_pt: 842,
          rotation: 0,
          pdf_crop_box: [0, 0, 595, 842],
        },
      ],
    },
    ruleset: { id: "demo-plate-part", version: "0.1.0" },
    measurements: ms,
    unrecognized_annotations: [],
    findings: fs,
    summary: {
      passed: count("pass"),
      failed: count("fail"),
      missing: count("missing"),
      needs_review: count("needs_review"),
    },
    cad_annotations: [],
    cad_unit_note: null,
    skipped_angled_lines: 0,
    processing_time_ms: 1203.4,
    disclaimer: "BlueprintIQ is an assistive engineering prototype.",
    ...overrides,
  };
}

/** One finding per outcome, over measurements that include an ambiguous one. */
export function allOutcomesReport(): InspectionReport {
  return makeReport({
    measurements: [
      dimension({ id: "M1" }),
      ambiguousDimension({ id: "M2" }),
      dimension({
        id: "M3",
        dimension_type: "diameter",
        value: "60",
        normalized_value_mm: "60",
        source: source("DIAMETER: 60 mm"),
      }),
    ],
    findings: [
      finding("pass", { id: "F1" }),
      finding("missing", {
        id: "F2",
        rule_id: "MAT-REQ-001",
        rule_description: "A material specification must be present.",
        expected: "a readable material annotation",
        message: "No material annotation was found.",
      }),
      finding("needs_review", {
        id: "F3",
        rule_id: "LEN-RANGE-001",
        severity: "warning",
        rule_description: "Overall length must be between 10 mm and 500 mm.",
        measurement_ids: ["M2"],
        // Evidence is a copy of the measurement's source, which has no location here.
        evidence: [{ measurement_id: "M2", page_number: 1, bbox: null }],
        expected: "between 10 mm and 500 mm (inclusive)",
        actual: "LENGTH: 12 M",
        message: "The unit is ambiguous, so the length cannot be judged.",
      }),
      finding("fail", {
        id: "F4",
        rule_id: "DIA-MAX-001",
        rule_description: "Hole diameter must not exceed 50 mm.",
        measurement_ids: ["M3"],
        expected: "<= 50 mm",
        actual: "60 mm",
        message: "Diameter 60 mm exceeds the limit (<= 50 mm).",
      }),
    ],
  });
}

export function errorBody(code: string, message = "Backend message.", requestId = REQUEST_ID) {
  return { error: { code, message, request_id: requestId } };
}

/** A File of a given size without allocating its bytes. */
export function fileOfSize(name: string, type: string, size: number): File {
  const file = new File(["%PDF-1.4"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

export const pdf = (name = "drawing.pdf", size = 1319) => fileOfSize(name, "application/pdf", size);
export const AT_LIMIT = MAX_UPLOAD_BYTES;
export const OVER_LIMIT = MAX_UPLOAD_BYTES + 1;

/** The demonstration requirements, parsed: what an untouched form sends. */
export const DEMO_REQUIREMENTS = (() => {
  const parsed = parseRequirements(DEMO_FORM);
  if (!parsed.ok) throw new Error("demonstration requirements are invalid");
  return parsed satisfies ParsedRequirements;
})();

export const cadAnnotation = (
  id: string,
  rawText: string,
  overrides: Partial<InspectionReport["cad_annotations"][number]> = {},
): InspectionReport["cad_annotations"][number] => ({
  id,
  association: "none",
  dimension_kind: "linear",
  nominal: "2.7",
  upper_deviation: "0.1",
  lower_deviation: "-0.1",
  unit: "mm",
  unit_source: "drawing_note",
  tolerance_source: "inline",
  tolerance_parts: [],
  status: "parsed",
  issues: [],
  source: {
    page_number: 1,
    bbox: { x0: 72, y0: 100, x1: 120, y1: 112 },
    raw_text: rawText,
    extraction_method: "pdf_text_layer",
  },
  ...overrides,
});
