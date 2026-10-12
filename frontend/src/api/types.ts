// Names for the generated API types (src/api/schema.d.ts, produced from the backend's
// OpenAPI snapshot by `npm run api:types`). Only aliases are written by hand, so a
// backend schema change surfaces as a type error where it matters.
import type { SchemaDimensionMeasurement, SchemaMaterialAnnotation } from "./schema";

export type {
  SchemaBBox as BBox,
  SchemaDimensionMeasurement as DimensionMeasurement,
  SchemaDimensionType as DimensionType,
  SchemaDocumentInfo as DocumentInfo,
  SchemaEvidenceRef as EvidenceRef,
  SchemaExtractionIssue as ExtractionIssue,
  SchemaExtractionStatus as ExtractionStatus,
  SchemaFinding as Finding,
  SchemaFindingStatus as FindingStatus,
  SchemaFindingSummary as FindingSummary,
  SchemaInspectionReport as InspectionReport,
  SchemaLengthUnit as LengthUnit,
  SchemaMaterialAnnotation as MaterialAnnotation,
  SchemaPageInfo as PageInfo,
  SchemaRulesetInfo as RulesetInfo,
  SchemaSeverity as Severity,
  SchemaSourceEvidence as SourceEvidence,
  SchemaUnrecognizedAnnotation as UnrecognizedAnnotation,
} from "./schema";

/** A measurement is a numeric dimension or a textual material; `kind` tells which. */
export type Measurement = SchemaDimensionMeasurement | SchemaMaterialAnnotation;
