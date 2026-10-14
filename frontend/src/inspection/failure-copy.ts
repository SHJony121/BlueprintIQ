import { MAX_UPLOAD_BYTES } from "@/lib/limits";
import type { Failure } from "./state";
import type { FileProblem } from "./validate-file";

export interface FailureCopy {
  title: string;
  explanation: string;
  /** What the person can do about it. */
  hint?: string;
  /** Worth trying the same file again (the cause is not the file). */
  retryable: boolean;
  /** Identifiers for support and debugging, shown as labelled values. */
  details: { label: string; value: string }[];
}

interface Entry {
  title: string;
  explanation: string;
  hint?: string;
  retryable?: boolean;
}

// Explanations for the codes in the backend's error envelope (backend/.../api/errors.py)
// and for the codes the Next.js proxy adds (docs/frontend-f1.md). Written from what each
// refusal actually checks; none promises that a retry will help unless it can.
const API_CODES: Record<string, Entry> = {
  UNSUPPORTED_FILE_TYPE: {
    title: "This is not a PDF file",
    explanation:
      "The file does not begin like a PDF document, whatever its name says.",
    hint: "Export or print the drawing to PDF and choose that file.",
  },
  UNSUPPORTED_CONTENT_TYPE: {
    title: "The upload was not sent as a PDF",
    explanation: "The service only accepts a PDF sent as application/pdf.",
    hint: "Reload the page and try again.",
  },
  EMPTY_FILE: {
    title: "The file is empty",
    explanation: "The upload contained no data.",
    hint: "Choose a PDF that opens correctly on your computer.",
  },
  FILE_TOO_LARGE: {
    title: "The file is too large",
    explanation: "The upload is larger than the 10 MiB limit.",
    hint: "Export a smaller PDF, for example without embedded images.",
  },
  INVALID_PDF: {
    title: "The PDF could not be read",
    explanation: "The file is damaged, or built in a way this tool cannot open.",
    hint: "Check that it opens in a PDF viewer, or export it again.",
  },
  ENCRYPTED_PDF: {
    title: "The PDF is encrypted",
    explanation: "Password-protected or encrypted PDFs cannot be read.",
    hint: "Remove the protection and choose the file again.",
  },
  TOO_MANY_PAGES: {
    title: "Only single-page drawings are supported",
    explanation: "This PDF has more than one page.",
    hint: "Export the drawing sheet on its own.",
  },
  NO_TEXT_LAYER: {
    title: "No readable text found",
    explanation:
      "The PDF has no visible text. Scanned drawings and images of drawings are not supported, because the text is read directly from the file.",
    hint: "Export a PDF with selectable text from the CAD system.",
  },
  TOO_MANY_TEXT_LINES: {
    title: "The drawing has too much text",
    explanation: "It contains more than 5,000 lines of text, which is over the limit.",
  },
  UNSUPPORTED_GEOMETRY: {
    title: "The page layout is not supported",
    explanation:
      "The page uses a rotation that is not a multiple of 90 degrees, a UserUnit scale, text drawn at an angle, or has no usable visible area.",
    hint: "Export the sheet again with a standard page setup.",
  },
  PARTIALLY_VISIBLE_TEXT: {
    title: "Some text is cut off",
    explanation:
      "Part of the text lies outside, or is clipped by, the visible page area, so its position cannot be trusted.",
    hint: "Check the page crop and export again.",
  },
  PAGE_TOO_COMPLEX: {
    title: "The page is too complex",
    explanation:
      "Its drawing content, text or nesting is above what the tool will process safely.",
  },
  PROCESSING_TIMEOUT: {
    title: "Processing took too long",
    explanation: "The inspection was stopped after reaching its time limit.",
  },
  RESOURCE_LIMIT_EXCEEDED: {
    title: "The file needed too many resources",
    explanation: "Processing was stopped after reaching its memory limit.",
  },
  PROCESSING_FAILED: {
    title: "The PDF could not be processed",
    explanation: "Something went wrong while reading this file.",
    hint: "Try again, or export the PDF again.",
    retryable: true,
  },
  REQUEST_VALIDATION_ERROR: {
    title: "The request was not accepted",
    explanation:
      "Something in the request was invalid, for example a file name longer than 255 characters.",
    hint: "Rename the file with a shorter name and choose it again.",
  },
  INVALID_REQUIREMENTS: {
    title: "The requirements were not accepted",
    explanation: "The inspection requirements were refused as invalid.",
    hint: "Check the values in the requirements section and run the inspection again.",
  },
  CLIENT_DISCONNECTED: {
    title: "The upload was interrupted",
    explanation: "The connection closed before the whole file arrived.",
    retryable: true,
  },
  UPLOAD_TIMEOUT: {
    title: "The upload took too long",
    explanation: "The file did not arrive within the time allowed.",
    retryable: true,
  },
  SERVER_BUSY: {
    title: "The inspection service is busy",
    explanation: "It is handling other requests right now.",
    hint: "Wait a moment and try again.",
    retryable: true,
  },
  INTERNAL_ERROR: {
    title: "The inspection service had an unexpected error",
    explanation: "The error is on the service side, not in your file.",
    retryable: true,
  },
  NOT_FOUND: {
    title: "The inspection endpoint was not found",
    explanation: "The app could not find the service it sends drawings to.",
  },
  METHOD_NOT_ALLOWED: {
    title: "The inspection endpoint refused the request",
    explanation: "The app and the service disagree about how to send a drawing.",
  },
  // Added by the Next.js proxy, not the backend.
  FORBIDDEN: {
    title: "The request was refused",
    explanation: "The app only accepts uploads from its own pages, and this page was opened another way.",
    hint: "Open the app at its normal address, not through another site or a different host name.",
  },
  RATE_LIMITED: {
    title: "Too many inspections in a short time",
    explanation: "This connection has sent several drawings very recently.",
    hint: "Wait a minute and try again.",
    retryable: true,
  },
  TOO_MANY_UPLOADS: {
    title: "An inspection is already running",
    explanation: "This connection already has the maximum number of drawings being inspected.",
    hint: "Wait for it to finish, then try again.",
    retryable: true,
  },
  BACKEND_UNAVAILABLE: {
    title: "The inspection service is not reachable",
    explanation: "It is not running, or it closed the connection before answering.",
    hint: "Start the backend (see the README) and try again.",
    retryable: true,
  },
  BACKEND_INVALID_RESPONSE: {
    title: "The inspection service sent an unusable reply",
    explanation: "The reply was cut off, too large, or not in the expected form.",
    retryable: true,
  },
  BACKEND_TIMEOUT: {
    title: "The inspection service did not answer in time",
    explanation: "It is taking longer than the app is willing to wait.",
    retryable: true,
  },
  PROXY_MISCONFIGURED: {
    title: "The app is not configured correctly",
    explanation: "The address of the inspection service is invalid.",
    hint: "Check the BLUEPRINTIQ_BACKEND_URL setting and restart the app.",
  },
};

export function describeFailure(failure: Failure): FailureCopy {
  switch (failure.kind) {
    case "api": {
      const known = API_CODES[failure.code];
      const details = [
        { label: "Code", value: failure.code },
        { label: "HTTP status", value: String(failure.status) },
        ...(failure.requestId ? [{ label: "Request ID", value: failure.requestId }] : []),
      ];
      if (known !== undefined) {
        return { ...known, retryable: known.retryable ?? false, details };
      }
      // A code this version of the app does not know: say so, and show what was sent.
      return {
        title: "The inspection service reported an error",
        explanation: failure.message
          ? `The service said: ${failure.message}`
          : "The service did not say what went wrong.",
        retryable: failure.status >= 500,
        details,
      };
    }
    case "malformed":
      return {
        title: "The reply could not be understood",
        explanation:
          "The service answered, but not in the format this app expects, so nothing was shown. This is not a result for your drawing.",
        hint: "Try again. If it keeps happening, the app and the service may be out of date with each other.",
        retryable: true,
        details: [
          { label: "HTTP status", value: String(failure.status) },
          { label: "Problem", value: failure.problem },
          ...(failure.requestId ? [{ label: "Request ID", value: failure.requestId }] : []),
        ],
      };
    case "network":
      return {
        title: "The app could not be reached",
        explanation: "The request did not get an answer. The app server may have stopped.",
        hint: "Check that the app is still running, then try again.",
        retryable: true,
        details: [],
      };
    case "timeout":
      return {
        title: "No answer was received",
        explanation: "The request was abandoned after waiting more than two minutes.",
        hint: "The service may be overloaded. Try again in a moment.",
        retryable: true,
        details: [],
      };
  }
}

/** Problems found in the browser, before anything is uploaded. */
export function describeFileProblem(
  problem: FileProblem,
  fileName: string,
  sizeBytes: number | null,
): FailureCopy {
  const details = [{ label: "File", value: fileName }];
  switch (problem) {
    case "not_pdf":
      return {
        title: "Choose a PDF file",
        explanation: "Only PDF drawings can be inspected, and this file does not look like one.",
        hint: "Export or print the drawing to PDF first.",
        retryable: false,
        details,
      };
    case "empty":
      return {
        title: "The file is empty",
        explanation: "It has no content.",
        hint: "Choose a PDF that opens correctly on your computer.",
        retryable: false,
        details,
      };
    case "too_large":
      return {
        title: "The file is too large",
        explanation: `The limit is ${formatCount(MAX_UPLOAD_BYTES)} bytes (10 MiB).`,
        hint: "Export a smaller PDF, for example without embedded images.",
        retryable: false,
        details: [
          ...details,
          ...(sizeBytes === null ? [] : [{ label: "Size", value: `${formatCount(sizeBytes)} bytes` }]),
        ],
      };
    case "multiple":
      return {
        title: "Choose one file at a time",
        explanation: "Several files were selected, and an inspection covers one drawing.",
        hint: "Pick a single PDF.",
        retryable: false,
        details: [],
      };
  }
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
