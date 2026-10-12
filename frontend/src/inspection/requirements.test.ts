import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_FORM, parseRequirements, type RequirementsForm } from "./requirements";

const form = (overrides: Partial<RequirementsForm> = {}): RequirementsForm => ({ ...DEMO_FORM, ...overrides });
const ok = (f: RequirementsForm) => {
  const result = parseRequirements(f);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
};
const errors = (f: RequirementsForm) => {
  const result = parseRequirements(f);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
};

describe("the demonstration values", () => {
  it("equal the backend's demo_rules.toml, so the two cannot drift apart", () => {
    const toml = readFileSync(
      path.resolve(import.meta.dirname, "../../../backend/src/blueprintiq/rules/demo_rules.toml"),
      "utf8",
    );
    const value = (id: string, key: string) =>
      new RegExp(`id = "${id}"[\\s\\S]*?${key} = ([0-9.]+)`).exec(toml)?.[1];
    const same = (toml: string | undefined, text: string) => Number(toml) === Number(text);
    expect(same(value("THK-MIN-001", "min_mm"), DEMO_FORM.minThickness)).toBe(true);
    expect(same(value("DIA-MAX-001", "max_mm"), DEMO_FORM.maxDiameter)).toBe(true);
    expect(same(value("LEN-RANGE-001", "min_mm"), DEMO_FORM.minLength)).toBe(true);
    expect(same(value("LEN-RANGE-001", "max_mm"), DEMO_FORM.maxLength)).toBe(true);
    expect(toml).toMatch(/id = "MAT-REQ-001"[\s\S]*?kind = "required"/); // material presence, no code
  });

  it("send no header at all, so the server's own ruleset applies", () => {
    const demo = ok(DEMO_FORM);
    expect(demo.isDemo).toBe(true);
    expect(demo.header).toBeNull();
  });

  it("are still the demonstration values when written differently (3.0, spaces)", () => {
    expect(ok(form({ minThickness: " 3.0 ", maxLength: "500.000" })).isDemo).toBe(true);
  });
});

describe("custom requirements", () => {
  it("become an encoded header carrying exact decimal text", () => {
    const parsed = ok(form({ minThickness: "2.35", maxDiameter: "0.1", materialCode: " ss400 " }));
    expect(parsed.isDemo).toBe(false);
    expect(JSON.parse(decodeURIComponent(parsed.header!))).toEqual({
      version: 1,
      min_thickness_mm: "2.35",
      max_diameter_mm: "0.1",
      min_length_mm: "10",
      max_length_mm: "500",
      material: { required: true, code: "SS400" },
    });
    expect(parsed.header).toMatch(/^[\x20-\x7e]*$/); // header-safe
    expect(parsed.header!.length).toBeLessThan(2048);
  });

  it("leave a blank limit out, and may leave everything but one limit out", () => {
    const parsed = ok(form({ minThickness: "", maxDiameter: "", minLength: "", maxLength: "800", materialRequired: false }));
    expect(parsed.wire).toEqual({
      version: 1,
      min_thickness_mm: null,
      max_diameter_mm: null,
      min_length_mm: null,
      max_length_mm: "800",
      material: null,
    });
  });

  it("have a key that ignores how a number is written but not its value", () => {
    expect(ok(form({ minThickness: "4" })).key).toBe(ok(form({ minThickness: "4.0" })).key);
    expect(ok(form({ minThickness: "4" })).key).not.toBe(ok(form({ minThickness: "4.000001" })).key);
    expect(ok(form({ materialCode: "SS400" })).key).not.toBe(ok(form({ materialCode: "" })).key);
  });
});

describe("invalid requirements", () => {
  it.each(["-1", "1e3", "3,5", "abc", "0.1234567", "1234567890123", "03", "NaN", "Infinity", "1.", ".5", "0x10"])(
    "refuses %j as a threshold, naming the field",
    (bad) => {
      expect(errors(form({ minThickness: bad })).minThickness).toMatch(/number/);
      expect(Object.keys(errors(form({ maxDiameter: bad })))).toEqual(["maxDiameter"]);
    },
  );

  it("accepts the edges of the allowed range", () => {
    expect(ok(form({ minThickness: "0" })).wire.min_thickness_mm).toBe("0");
    expect(ok(form({ minThickness: "999999999999.999999" })).wire.min_thickness_mm).toBe("999999999999.999999");
  });

  it("compares a length range exactly, not as floating point", () => {
    expect(errors(form({ minLength: "10", maxLength: "9.999999" })).minLength).toMatch(/greater/);
    expect(ok(form({ minLength: "10", maxLength: "10.000000" }))).toBeTruthy(); // equal is allowed
    expect(ok(form({ minLength: "0.1", maxLength: "0.3" }))).toBeTruthy();
    expect(ok(form({ minLength: "9", maxLength: "10" }))).toBeTruthy(); // 9 < 10 although "9" > "10" as text
  });

  it.each(["", "X;Y", "A".repeat(33), "-SS400", "é"])("refuses material code %j only when one is required", (code) => {
    if (code.trim() !== "") expect(errors(form({ materialCode: code })).materialCode).toBeDefined();
    expect(ok(form({ materialRequired: false, materialCode: code })).wire.material).toBeNull();
  });

  it("needs at least one requirement", () => {
    const empty = form({ minThickness: "", maxDiameter: "", minLength: "", maxLength: "", materialRequired: false });
    expect(errors(empty).form).toMatch(/at least one/i);
  });

  it("reports every bad field at once", () => {
    expect(Object.keys(errors(form({ minThickness: "x", maxDiameter: "y", maxLength: "z" }))).sort()).toEqual([
      "maxDiameter",
      "maxLength",
      "minThickness",
    ]);
  });
});
