import { MAX_UPLOAD_BYTES } from "@/lib/limits";

// Early checks in the browser, so an obviously unusable file never leaves the machine.
// The backend still validates everything (signature, structure, limits); these only
// save a round trip and give a clearer message.
export type FileProblem = "empty" | "not_pdf" | "too_large" | "multiple";

export function validateFile(file: File): FileProblem | null {
  if (!looksLikePdf(file)) return "not_pdf";
  if (file.size === 0) return "empty";
  if (file.size > MAX_UPLOAD_BYTES) return "too_large";
  return null;
}

// Browsers derive `type` from the extension; some leave it empty for unknown ones.
// A PDF type is enough; an empty type needs the .pdf extension; any other type is out.
function looksLikePdf(file: File): boolean {
  if (file.type === "application/pdf") return true;
  return file.type === "" && /\.pdf$/i.test(file.name);
}

/** Pick the one file to inspect, or say why not. */
export type Choice =
  | { file: File }
  | { problem: FileProblem; fileName: string; sizeBytes: number | null };

export function chooseFile(files: readonly File[]): Choice | null {
  const [first] = files;
  if (first === undefined) return null;
  if (files.length > 1) {
    return { problem: "multiple", fileName: `${files.length} files`, sizeBytes: null };
  }
  const problem = validateFile(first);
  return problem === null
    ? { file: first }
    : { problem, fileName: first.name, sizeBytes: first.size };
}
