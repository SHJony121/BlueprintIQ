import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES } from "@/lib/limits";
import { AT_LIMIT, fileOfSize, OVER_LIMIT, pdf } from "../../tests/ui/builders";
import { chooseFile, validateFile } from "./validate-file";

describe("file size", () => {
  it("is exactly 10 MiB at the limit", () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_UPLOAD_BYTES).toBe(10_485_760);
  });

  it.each([
    [0, "empty"],
    [1, null],
    [1319, null],
    [AT_LIMIT - 1, null],
    [AT_LIMIT, null],
    [OVER_LIMIT, "too_large"],
    [AT_LIMIT * 5, "too_large"],
  ])("a %i byte PDF gives %s", (size, expected) => {
    expect(validateFile(pdf("drawing.pdf", size))).toBe(expected);
  });
});

describe("file type", () => {
  it.each([
    ["application/pdf", "drawing.pdf", null],
    ["application/pdf", "DRAWING.PDF", null],
    ["application/pdf", "no-extension", null],
    ["", "drawing.pdf", null],
    ["", "Drawing.Pdf", null],
    ["", "drawing.txt", "not_pdf"],
    ["", "drawing", "not_pdf"],
    ["", "drawing.pdf.exe", "not_pdf"],
    ["text/plain", "drawing.pdf", "not_pdf"],
    ["image/png", "drawing.pdf", "not_pdf"],
    ["application/octet-stream", "drawing.pdf", "not_pdf"],
    ["application/zip", "drawing.zip", "not_pdf"],
    ["image/png", "drawing.png", "not_pdf"],
  ])("type %j named %j gives %s", (type, name, expected) => {
    expect(validateFile(fileOfSize(name, type, 1319))).toBe(expected);
  });

  it("reports a wrong type before a wrong size", () => {
    expect(validateFile(fileOfSize("big.png", "image/png", OVER_LIMIT))).toBe("not_pdf");
    expect(validateFile(fileOfSize("empty.txt", "text/plain", 0))).toBe("not_pdf");
  });
});

describe("choosing one file", () => {
  it("picks nothing from an empty selection (a cancelled dialog)", () => {
    expect(chooseFile([])).toBeNull();
  });

  it("accepts one valid file", () => {
    const file = pdf();
    expect(chooseFile([file])).toEqual({ file });
  });

  it("explains a refused file, with its name and size", () => {
    const file = fileOfSize("plan.png", "image/png", 99);
    expect(chooseFile([file])).toEqual({ problem: "not_pdf", fileName: "plan.png", sizeBytes: 99 });
  });

  it("refuses several files instead of silently using the first", () => {
    expect(chooseFile([pdf("a.pdf"), pdf("b.pdf")])).toEqual({
      problem: "multiple",
      fileName: "2 files",
      sizeBytes: null,
    });
  });
});
