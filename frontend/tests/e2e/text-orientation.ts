// Which side of each text line is "up" on screen, read from PDF.js's own parse of the file
// (each text item's matrix), not from the code under test. The alignment check uses it to
// hold the ascender side of a box tight and give the descender side its room.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Side } from "./alignment";

type PdfJs = typeof import("pdfjs-dist");
let loading: Promise<PdfJs> | null = null;

function pdfjs(): Promise<PdfJs> {
  loading ??= (async () => {
    const build = path.join(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build");
    const lib = (await import(pathToFileURL(path.join(build, "pdf.mjs")).href)) as PdfJs;
    lib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(build, "pdf.worker.mjs")).href;
    return lib;
  })();
  return loading;
}

/** For each line of text, the screen side its glyphs' tops point to; null if not found. */
export async function upSides(file: string, lines: readonly string[]): Promise<(Side | null)[]> {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 });
  try {
    const page = await (await task.promise).getPage(1);
    const [a, b, c, d] = page.getViewport({ scale: 1 }).transform as number[];
    const content = await page.getTextContent();
    const items = content.items.flatMap((item) =>
      "str" in item && item.str.trim() !== "" ? [{ text: item.str.trim(), matrix: item.transform as number[] }] : [],
    );
    return lines.map((line) => {
      // The longest text item that starts this line (a line may be drawn in several runs).
      const match = items
        .filter((item) => line.startsWith(item.text))
        .sort((x, y) => y.text.length - x.text.length)[0];
      if (match === undefined) return null;
      // The text matrix's second column is the glyphs' up direction in PDF space; the
      // viewport's linear part turns it into a screen direction (y down).
      const [, , ux, uy] = match.matrix;
      const sx = a! * ux! + c! * uy!;
      const sy = b! * ux! + d! * uy!;
      if (Math.abs(sx) > Math.abs(sy)) return sx > 0 ? "right" : "left";
      return sy > 0 ? "bottom" : "top";
    });
  } finally {
    await task.destroy();
  }
}
