// Turns an HTTP response from POST /api/inspections into exactly one of three outcomes:
//
//   report     status 200 AND a body that passes every check below
//   error      a non-2xx status AND the backend's error envelope
//   malformed  anything else (not JSON, wrong shape, status and body disagreeing)
//
// A 200 carrying an error body, or an error status carrying a report, is `malformed`,
// never a result. The report is rebuilt field by field from the generated API types, so a
// backend schema change is a compile error here instead of silent drift. Decimal
// quantities stay strings; nothing is converted to a JS number.
import type {
  BBox,
  DimensionMeasurement,
  DimensionType,
  DocumentInfo,
  EvidenceRef,
  ExtractionIssue,
  ExtractionStatus,
  Finding,
  FindingStatus,
  FindingSummary,
  InspectionReport,
  LengthUnit,
  MaterialAnnotation,
  Measurement,
  PageInfo,
  Severity,
  SourceEvidence,
  UnrecognizedAnnotation,
} from "./types";

export type ApiOutcome =
  | { kind: "report"; report: InspectionReport; requestId: string | null }
  | { kind: "error"; status: number; code: string; message: string; requestId: string }
  | { kind: "malformed"; status: number; problem: string; requestId: string | null };

export class MalformedResponse extends Error {
  constructor(
    readonly path: string,
    readonly problem: string,
  ) {
    super(`${path}: ${problem}`);
  }
}

export function interpretResponse(
  status: number,
  bodyText: string,
  requestIdHeader: string | null,
): ApiOutcome {
  const headerId = requestIdHeader !== null && REQUEST_ID.test(requestIdHeader) ? requestIdHeader : null;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { kind: "malformed", status, problem: "the body is not valid JSON", requestId: headerId };
  }

  if (status === 200) {
    if (readErrorEnvelope(body) !== null) {
      return malformed(status, "an error body arrived with status 200", headerId);
    }
    try {
      return { kind: "report", report: readReport(body), requestId: headerId };
    } catch (error) {
      if (error instanceof MalformedResponse) return malformed(status, error.message, headerId);
      throw error;
    }
  }
  if (status < 400) {
    return malformed(status, "unexpected success or redirect status", headerId);
  }
  const envelope = readErrorEnvelope(body);
  if (envelope === null) return malformed(status, "the error body has an unexpected shape", headerId);
  return {
    kind: "error",
    status,
    code: envelope.code,
    message: envelope.message,
    requestId: envelope.request_id || headerId || "",
  };
}

function malformed(status: number, problem: string, requestId: string | null): ApiOutcome {
  return { kind: "malformed", status, problem, requestId };
}

const REQUEST_ID = /^[0-9a-f]{32}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MEASUREMENT_ID = /^M[1-9][0-9]*$/;
const FINDING_ID = /^F[1-9][0-9]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^[0-9]{1,30}(\.[0-9]{1,30})?$/;
const MAX_ERROR_MESSAGE = 300;

/** The backend's (and proxy's) error shape, or null if `value` is not one. */
export function readErrorEnvelope(
  value: unknown,
): { code: string; message: string; request_id: string } | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  const { code, message, request_id } = value.error;
  if (typeof code !== "string" || !ERROR_CODE.test(code)) return null;
  if (typeof message !== "string" || typeof request_id !== "string") return null;
  return {
    code,
    message: message.slice(0, MAX_ERROR_MESSAGE),
    request_id: REQUEST_ID.test(request_id) ? request_id : "",
  };
}

// ----------------------------------------------------------------------- report

export function readReport(value: unknown): InspectionReport {
  const o = record(value, "report");
  if (o.schema_version !== "1.0") bad("schema_version", "unsupported report version");
  const report: InspectionReport = {
    schema_version: "1.0",
    document: readDocument(o.document, "document"),
    ruleset: readRuleset(o.ruleset, "ruleset"),
    measurements: list(o.measurements, "measurements").map((m, i) =>
      readMeasurement(m, `measurements[${i}]`),
    ),
    unrecognized_annotations: list(o.unrecognized_annotations, "unrecognized_annotations").map(
      (a, i) => readUnrecognized(a, `unrecognized_annotations[${i}]`),
    ),
    findings: list(o.findings, "findings").map((f, i) => readFinding(f, `findings[${i}]`)),
    summary: readSummary(o.summary, "summary"),
    skipped_angled_lines: count(o.skipped_angled_lines, "skipped_angled_lines"),
    processing_time_ms: finite(o.processing_time_ms, "processing_time_ms", 0),
    disclaimer: str(o.disclaimer, "disclaimer"),
  };
  crossCheck(report);
  return report;
}

/** Relationships the UI relies on: unique ids, resolvable references, honest totals. */
function crossCheck(report: InspectionReport): void {
  const measurementIds = new Set<string>();
  for (const m of report.measurements) {
    if (measurementIds.has(m.id)) bad("measurements", `duplicate id ${m.id}`);
    measurementIds.add(m.id);
  }
  const findingIds = new Set<string>();
  const counts: Record<FindingStatus, number> = { pass: 0, fail: 0, missing: 0, needs_review: 0 };
  for (const f of report.findings) {
    if (findingIds.has(f.id)) bad("findings", `duplicate id ${f.id}`);
    findingIds.add(f.id);
    counts[f.status] += 1;
    for (const id of f.measurement_ids) {
      if (!measurementIds.has(id)) bad(`findings ${f.id}`, `references unknown measurement ${id}`);
    }
  }
  const s = report.summary;
  if (
    s.passed !== counts.pass ||
    s.failed !== counts.fail ||
    s.missing !== counts.missing ||
    s.needs_review !== counts.needs_review
  ) {
    bad("summary", "totals do not match the findings");
  }
  const pages = new Set(report.document.pages.map((p) => p.page_number));
  for (const m of report.measurements) {
    if (!pages.has(m.source.page_number)) bad(`measurement ${m.id}`, "page is not in the document");
  }
}

function readDocument(value: unknown, path: string): DocumentInfo {
  const o = record(value, path);
  const pages = list(o.pages, `${path}.pages`).map((p, i) => readPage(p, `${path}.pages[${i}]`));
  const document: DocumentInfo = {
    filename: nullable(o.filename, `${path}.filename`, str),
    sha256: pattern(o.sha256, `${path}.sha256`, SHA256),
    size_bytes: count(o.size_bytes, `${path}.size_bytes`, 1),
    page_count: count(o.page_count, `${path}.page_count`, 1),
    pages,
  };
  if (pages.length === 0 || document.page_count !== pages.length) {
    bad(path, "page_count does not match the pages");
  }
  return document;
}

function readPage(value: unknown, path: string): PageInfo {
  const o = record(value, path);
  const box = list(o.pdf_crop_box, `${path}.pdf_crop_box`);
  if (box.length !== 4) bad(`${path}.pdf_crop_box`, "expected four numbers");
  return {
    page_number: count(o.page_number, `${path}.page_number`, 1),
    width_pt: finite(o.width_pt, `${path}.width_pt`, 0, true),
    height_pt: finite(o.height_pt, `${path}.height_pt`, 0, true),
    rotation: rotation(o.rotation, `${path}.rotation`),
    pdf_crop_box: [
      finite(box[0], `${path}.pdf_crop_box[0]`),
      finite(box[1], `${path}.pdf_crop_box[1]`),
      finite(box[2], `${path}.pdf_crop_box[2]`),
      finite(box[3], `${path}.pdf_crop_box[3]`),
    ],
  };
}

function readRuleset(value: unknown, path: string) {
  const o = record(value, path);
  return { id: str(o.id, `${path}.id`), version: str(o.version, `${path}.version`) };
}

function readBBox(value: unknown, path: string): BBox {
  const o = record(value, path);
  const box = {
    x0: finite(o.x0, `${path}.x0`),
    y0: finite(o.y0, `${path}.y0`),
    x1: finite(o.x1, `${path}.x1`),
    y1: finite(o.y1, `${path}.y1`),
  };
  if (box.x0 > box.x1 || box.y0 > box.y1) bad(path, "box corners are out of order");
  return box;
}

function readSource(value: unknown, path: string): SourceEvidence {
  const o = record(value, path);
  return {
    page_number: count(o.page_number, `${path}.page_number`, 1),
    bbox: o.bbox === undefined || o.bbox === null ? null : readBBox(o.bbox, `${path}.bbox`),
    raw_text: str(o.raw_text, `${path}.raw_text`),
    extraction_method: oneOf(o.extraction_method, `${path}.extraction_method`, {
      pdf_text_layer: 1,
    }),
  };
}

const EXTRACTION_STATUSES = { parsed: 1, ambiguous: 1 } satisfies Record<ExtractionStatus, 1>;
const DIMENSION_TYPES = { thickness: 1, diameter: 1, length: 1 } satisfies Record<DimensionType, 1>;
const LENGTH_UNITS = { mm: 1, cm: 1, m: 1, in: 1 } satisfies Record<LengthUnit, 1>;
const EXTRACTION_ISSUES = {
  missing_value: 1,
  missing_unit: 1,
  unsupported_unit: 1,
  ambiguous_unit_case: 1,
  decimal_comma: 1,
  unsupported_syntax: 1,
} satisfies Record<ExtractionIssue, 1>;
const FINDING_STATUSES = {
  pass: 1,
  fail: 1,
  missing: 1,
  needs_review: 1,
} satisfies Record<FindingStatus, 1>;
const SEVERITIES = { error: 1, warning: 1, info: 1 } satisfies Record<Severity, 1>;

function readMeasurement(value: unknown, path: string): Measurement {
  const o = record(value, path);
  const issues = list(o.issues, `${path}.issues`).map((issue, i) =>
    oneOf(issue, `${path}.issues[${i}]`, EXTRACTION_ISSUES),
  );
  if (o.kind === "dimension") {
    const dimension: DimensionMeasurement = {
      kind: "dimension",
      id: pattern(o.id, `${path}.id`, MEASUREMENT_ID),
      dimension_type: oneOf(o.dimension_type, `${path}.dimension_type`, DIMENSION_TYPES),
      value: nullable(o.value, `${path}.value`, decimal),
      unit: nullable(o.unit, `${path}.unit`, (v, p) => oneOf(v, p, LENGTH_UNITS)),
      normalized_value_mm: nullable(o.normalized_value_mm, `${path}.normalized_value_mm`, decimal),
      status: oneOf(o.status, `${path}.status`, EXTRACTION_STATUSES),
      issues,
      source: readSource(o.source, `${path}.source`),
    };
    return dimension;
  }
  if (o.kind === "material") {
    const material: MaterialAnnotation = {
      kind: "material",
      id: pattern(o.id, `${path}.id`, MEASUREMENT_ID),
      value: nullable(o.value, `${path}.value`, str),
      status: oneOf(o.status, `${path}.status`, EXTRACTION_STATUSES),
      issues,
      source: readSource(o.source, `${path}.source`),
    };
    return material;
  }
  return bad(`${path}.kind`, "unknown measurement kind");
}

function readUnrecognized(value: unknown, path: string): UnrecognizedAnnotation {
  const o = record(value, path);
  return { label: str(o.label, `${path}.label`), source: readSource(o.source, `${path}.source`) };
}

function readEvidence(value: unknown, path: string): EvidenceRef {
  const o = record(value, path);
  return {
    measurement_id: pattern(o.measurement_id, `${path}.measurement_id`, MEASUREMENT_ID),
    page_number: count(o.page_number, `${path}.page_number`, 1),
    bbox: o.bbox === null ? null : readBBox(o.bbox, `${path}.bbox`),
  };
}

function readFinding(value: unknown, path: string): Finding {
  const o = record(value, path);
  const finding: Finding = {
    id: pattern(o.id, `${path}.id`, FINDING_ID),
    rule_id: str(o.rule_id, `${path}.rule_id`),
    rule_description: str(o.rule_description, `${path}.rule_description`),
    status: oneOf(o.status, `${path}.status`, FINDING_STATUSES),
    severity: oneOf(o.severity, `${path}.severity`, SEVERITIES),
    measurement_ids: list(o.measurement_ids, `${path}.measurement_ids`).map((id, i) =>
      pattern(id, `${path}.measurement_ids[${i}]`, MEASUREMENT_ID),
    ),
    evidence: list(o.evidence, `${path}.evidence`).map((e, i) =>
      readEvidence(e, `${path}.evidence[${i}]`),
    ),
    expected: str(o.expected, `${path}.expected`),
    actual: nullable(o.actual, `${path}.actual`, str),
    message: str(o.message, `${path}.message`),
  };
  const sameIds =
    finding.evidence.length === finding.measurement_ids.length &&
    finding.evidence.every((e, i) => e.measurement_id === finding.measurement_ids[i]);
  if (!sameIds) bad(path, "evidence does not match measurement_ids");
  return finding;
}

function readSummary(value: unknown, path: string): FindingSummary {
  const o = record(value, path);
  return {
    passed: count(o.passed, `${path}.passed`),
    failed: count(o.failed, `${path}.failed`),
    missing: count(o.missing, `${path}.missing`),
    needs_review: count(o.needs_review, `${path}.needs_review`),
  };
}

// ---------------------------------------------------------------------- helpers

type Rec = Record<string, unknown>;

function bad(path: string, problem: string): never {
  throw new MalformedResponse(path, problem);
}

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Rec {
  return isRecord(value) ? value : bad(path, "expected an object");
}

function list(value: unknown, path: string): unknown[] {
  return Array.isArray(value) ? value : bad(path, "expected a list");
}

function str(value: unknown, path: string): string {
  return typeof value === "string" ? value : bad(path, "expected text");
}

function pattern(value: unknown, path: string, expected: RegExp): string {
  const text = str(value, path);
  return expected.test(text) ? text : bad(path, "unexpected format");
}

/** A Decimal quantity as the backend serializes it: plain-notation text, kept as text. */
function decimal(value: unknown, path: string): string {
  return pattern(value, path, DECIMAL);
}

function nullable<T>(value: unknown, path: string, read: (v: unknown, p: string) => T): T | null {
  return value === null ? null : read(value, path);
}

function count(value: unknown, path: string, min = 0): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min
    ? value
    : bad(path, "expected a whole number in range");
}

function finite(value: unknown, path: string, min?: number, exclusive = false): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return bad(path, "expected a number");
  if (min !== undefined && (exclusive ? value <= min : value < min)) {
    return bad(path, "number out of range");
  }
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: Record<T, unknown>): T {
  return typeof value === "string" && Object.hasOwn(allowed, value)
    ? (value as T)
    : bad(path, "unexpected value");
}

function rotation(value: unknown, path: string): 0 | 90 | 180 | 270 {
  return value === 0 || value === 90 || value === 180 || value === 270
    ? value
    : bad(path, "unexpected value");
}
