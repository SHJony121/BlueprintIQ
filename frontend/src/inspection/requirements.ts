// The limits an engineer wants an inspection checked against, from form text to the one
// request header that carries them (X-Inspection-Requirements). Pure functions.
//
// The backend validates everything again and is authoritative; these checks exist so a
// mistake is shown next to its field instead of as a failed request. Thresholds stay text
// from the form to the wire (decimal strings in millimetres), so nothing passes through a
// binary float. Rules mirror backend/src/blueprintiq/rules/requirements.py.

export interface RequirementsForm {
  minThickness: string;
  maxDiameter: string;
  minLength: string;
  maxLength: string;
  materialRequired: boolean;
  materialCode: string;
}

export type FieldName = keyof RequirementsForm;

/** The backend's demonstration ruleset (demo_rules.toml). A test keeps the two in step. */
export const DEMO_FORM: RequirementsForm = {
  minThickness: "3",
  maxDiameter: "50",
  minLength: "10",
  maxLength: "500",
  materialRequired: true,
  materialCode: "",
};

export const DEMO_NOTE = "Demonstration values. Not engineering standards.";

/** What is sent: decimal strings, null for "not checked". */
export interface WireRequirements {
  version: 1;
  min_thickness_mm: string | null;
  max_diameter_mm: string | null;
  min_length_mm: string | null;
  max_length_mm: string | null;
  material: { required: true; code: string | null } | null;
}

export interface ParsedRequirements {
  ok: true;
  wire: WireRequirements;
  /** Same requirements, same key: numerically equal values (3 and 3.0) compare equal. */
  key: string;
  /** Equal to the demonstration values, so no header is sent and the server's own ruleset applies. */
  isDemo: boolean;
  /** The percent-encoded header value, or null when the demonstration ruleset is meant. */
  header: string | null;
}

export type RequirementsResult =
  | ParsedRequirements
  | { ok: false; errors: Partial<Record<FieldName | "form", string>> };

const DECIMAL = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,31}$/;
const NUMBER_HELP = "Enter a number, 0 or more, with at most 6 decimals (for example 2.5).";

function threshold(
  text: string,
  field: FieldName,
  errors: Partial<Record<FieldName | "form", string>>,
): string | null {
  const value = text.trim();
  if (value === "") return null;
  if (!DECIMAL.test(value)) {
    errors[field] = NUMBER_HELP;
    return null;
  }
  return value;
}

/** Strip trailing zeros so 3, 3.0 and 3.000 are one value. Only used for comparison and keys. */
export function canonicalDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

function compareDecimal(a: string, b: string): number {
  // Exact: compare whole parts, then fractional digits padded to the same length.
  const [ai = "", af = ""] = a.split(".");
  const [bi = "", bf = ""] = b.split(".");
  if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const width = Math.max(af.length, bf.length);
  const x = af.padEnd(width, "0");
  const y = bf.padEnd(width, "0");
  return x === y ? 0 : x < y ? -1 : 1;
}

type Analysis =
  | { errors: Partial<Record<FieldName | "form", string>> }
  | { errors: null; wire: WireRequirements; key: string };

function analyse(form: RequirementsForm): Analysis {
  const errors: Partial<Record<FieldName | "form", string>> = {};
  const min_thickness_mm = threshold(form.minThickness, "minThickness", errors);
  const max_diameter_mm = threshold(form.maxDiameter, "maxDiameter", errors);
  const min_length_mm = threshold(form.minLength, "minLength", errors);
  const max_length_mm = threshold(form.maxLength, "maxLength", errors);
  if (
    min_length_mm !== null &&
    max_length_mm !== null &&
    compareDecimal(min_length_mm, max_length_mm) > 0
  ) {
    errors.minLength = "The minimum length is greater than the maximum length.";
  }

  let material: WireRequirements["material"] = null;
  if (form.materialRequired) {
    const code = form.materialCode.trim();
    if (code !== "" && !CODE.test(code)) {
      errors.materialCode = "Use 1 to 32 letters, digits, spaces or . _ / - characters.";
    }
    material = { required: true, code: code === "" ? null : code.toUpperCase() };
  }

  const wire: WireRequirements = {
    version: 1,
    min_thickness_mm,
    max_diameter_mm,
    min_length_mm,
    max_length_mm,
    material,
  };
  const checked = [min_thickness_mm, max_diameter_mm, min_length_mm, max_length_mm].some((v) => v !== null);
  if (!checked && material === null && Object.keys(errors).length === 0) {
    errors.form = "Add at least one requirement to check.";
  }
  if (Object.keys(errors).length > 0) return { errors };

  const canonical: WireRequirements = {
    ...wire,
    min_thickness_mm: min_thickness_mm === null ? null : canonicalDecimal(min_thickness_mm),
    max_diameter_mm: max_diameter_mm === null ? null : canonicalDecimal(max_diameter_mm),
    min_length_mm: min_length_mm === null ? null : canonicalDecimal(min_length_mm),
    max_length_mm: max_length_mm === null ? null : canonicalDecimal(max_length_mm),
  };
  return { errors: null, wire, key: JSON.stringify(canonical) };
}

const DEMO_KEY = (() => {
  const result = analyse(DEMO_FORM);
  if (result.errors !== null) throw new Error("the demonstration values are invalid");
  return result.key;
})();

export function parseRequirements(form: RequirementsForm): RequirementsResult {
  const result = analyse(form);
  if (result.errors !== null) return { ok: false, errors: result.errors };
  const isDemo = result.key === DEMO_KEY;
  return {
    ok: true,
    wire: result.wire,
    key: result.key,
    isDemo,
    header: isDemo ? null : encodeURIComponent(JSON.stringify(result.wire)),
  };
}
