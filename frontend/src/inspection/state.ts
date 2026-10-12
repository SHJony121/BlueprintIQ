import type { InspectionReport } from "@/api/types";
import type { FileProblem } from "./validate-file";

/** Why an inspection that was sent did not produce a report. Each kind is a different response type. */
export type Failure =
  | { kind: "api"; status: number; code: string; message: string; requestId: string }
  | { kind: "malformed"; status: number; problem: string; requestId: string | null }
  | { kind: "network" }
  | { kind: "timeout" };

// One value describes the whole screen, so a result can never be shown next to a
// different file's name or an error. Selecting a file always replaces the previous state.
export type InspectionState =
  | { status: "idle" }
  | { status: "rejected"; fileName: string; sizeBytes: number | null; problem: FileProblem }
  // A file chosen while the requirements are invalid: shown, not yet inspected.
  | { status: "waiting"; file: File }
  | { status: "running"; file: File; requirementsKey: string }
  | {
      status: "succeeded";
      file: File;
      fileName: string;
      report: InspectionReport;
      requestId: string | null;
      /** The requirements this report was produced with (see parseRequirements().key). */
      requirementsKey: string;
    }
  | { status: "failed"; file: File; failure: Failure; requirementsKey: string };

export type InspectionAction =
  | { type: "rejected"; fileName: string; sizeBytes: number | null; problem: FileProblem }
  | { type: "waiting"; file: File }
  | { type: "started"; file: File; requirementsKey: string }
  | {
      type: "succeeded";
      file: File;
      report: InspectionReport;
      requestId: string | null;
      requirementsKey: string;
    }
  | { type: "failed"; file: File; failure: Failure; requirementsKey: string }
  | { type: "cleared" };

export const initialState: InspectionState = { status: "idle" };

export function inspectionReducer(_: InspectionState, action: InspectionAction): InspectionState {
  switch (action.type) {
    case "rejected":
      return {
        status: "rejected",
        fileName: action.fileName,
        sizeBytes: action.sizeBytes,
        problem: action.problem,
      };
    case "waiting":
      return { status: "waiting", file: action.file };
    case "started":
      return { status: "running", file: action.file, requirementsKey: action.requirementsKey };
    case "succeeded":
      return {
        status: "succeeded",
        file: action.file,
        fileName: action.file.name,
        report: action.report,
        requestId: action.requestId,
        requirementsKey: action.requirementsKey,
      };
    case "failed":
      return {
        status: "failed",
        file: action.file,
        failure: action.failure,
        requirementsKey: action.requirementsKey,
      };
    case "cleared":
      return initialState;
  }
}
