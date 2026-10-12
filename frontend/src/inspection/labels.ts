import type {
  BBox,
  DimensionType,
  ExtractionIssue,
  ExtractionStatus,
  FindingStatus,
  Measurement,
  PageInfo,
  Severity,
} from "@/api/types";

// Plain-language names for the API's enum values. Records over the whole union, so a
// value added to the backend schema is a compile error until it has a label.

export const FINDING_LABEL: Record<FindingStatus, string> = {
  fail: "Fail",
  needs_review: "Needs review",
  missing: "Missing",
  pass: "Pass",
};

/** What each outcome means, kept next to its name so the four are never confused. */
export const FINDING_MEANING: Record<FindingStatus, string> = {
  fail: "A rule is not met",
  needs_review: "Could not be decided",
  missing: "Required item not found",
  pass: "A rule is met",
};

/** Attention first: problems before passes. */
export const FINDING_ORDER: readonly FindingStatus[] = ["fail", "needs_review", "missing", "pass"];

export const SEVERITY_LABEL: Record<Severity, string> = {
  error: "Error",
  warning: "Warning",
  info: "Info",
};

export const EXTRACTION_LABEL: Record<ExtractionStatus, string> = {
  parsed: "Read",
  ambiguous: "Ambiguous",
};

const DIMENSION_LABEL: Record<DimensionType, string> = {
  thickness: "Thickness",
  diameter: "Diameter",
  length: "Length",
};

export function measurementTypeLabel(m: Measurement): string {
  return m.kind === "material" ? "Material" : DIMENSION_LABEL[m.dimension_type];
}

export const ISSUE_LABEL: Record<ExtractionIssue, string> = {
  missing_value: "No value was found after the label",
  missing_unit: "No unit was given",
  unsupported_unit: "The unit is not supported",
  ambiguous_unit_case: "The unit's capitalisation is ambiguous (for example M or Mm)",
  decimal_comma: "A decimal comma was used, which is not interpreted",
  unsupported_syntax: "The wording is not a supported format",
};

/** A number and its unit must not be split across lines. */
export const NBSP = "\u00a0";

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}${NBSP}bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}${NBSP}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}${NBSP}MiB`;
}

export function formatBox(box: BBox): string {
  const n = (v: number) => v.toFixed(1);
  return `x ${n(box.x0)} to ${n(box.x1)}, y ${n(box.y0)} to ${n(box.y1)}${NBSP}pt`;
}

export function formatPage(page: PageInfo): string {
  return `${page.width_pt.toFixed(1)} × ${page.height_pt.toFixed(1)}${NBSP}pt, rotation ${page.rotation}°`;
}

export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}${NBSP}s` : `${Math.round(ms)}${NBSP}ms`;
}
