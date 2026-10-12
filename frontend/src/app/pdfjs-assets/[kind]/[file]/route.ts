import { readFile } from "node:fs/promises";
import path from "node:path";

// PDF.js's own data files (standard fonts, CMaps, image decoders, ICC profile), served from
// the installed pdfjs-dist so they always match the pinned version and no CDN is used.
// Only these four directories, and only file names of the expected form, are served.
export const runtime = "nodejs";

const PDFJS_DIR = path.join(process.cwd(), "node_modules", "pdfjs-dist");

const ALLOWED: Record<string, { pattern: RegExp; type: string }> = {
  standard_fonts: { pattern: /^[A-Za-z0-9-]+\.(pfb|ttf)$/, type: "application/octet-stream" },
  cmaps: { pattern: /^[A-Za-z0-9_.-]+\.bcmap$/, type: "application/octet-stream" },
  // Image decoders only; the scripting engine (quickjs) is not served: scripting is off.
  wasm: { pattern: /^(jbig2|openjpeg|qcms_bg)\.wasm$/, type: "application/wasm" },
  iccs: { pattern: /^[A-Za-z0-9_.-]+\.icc$/, type: "application/vnd.iccprofile" },
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ kind: string; file: string }> },
): Promise<Response> {
  const { kind, file } = await params;
  const rule = Object.hasOwn(ALLOWED, kind) ? ALLOWED[kind] : undefined;
  if (rule === undefined || !rule.pattern.test(file) || file.includes("..")) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const data = await readFile(path.join(PDFJS_DIR, kind, file));
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": rule.type,
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
