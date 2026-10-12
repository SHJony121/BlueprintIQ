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
  | { status: "running"; file: File }
  | { status: "succeeded"; fileName: string; report: InspectionReport; requestId: string | null }
  | { status: "failed"; file: File; failure: Failure };

export type InspectionAction =
  | { type: "rejected"; fileName: string; sizeBytes: number | null; problem: FileProblem }
  | { type: "started"; file: File }
  | { type: "succeeded"; fileName: string; report: InspectionReport; requestId: string | null }
  | { type: "failed"; file: File; failure: Failure }
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
    case "started":
      return { status: "running", file: action.file };
    case "succeeded":
      return {
        status: "succeeded",
        fileName: action.fileName,
        report: action.report,
        requestId: action.requestId,
      };
    case "failed":
      return { status: "failed", file: action.file, failure: action.failure };
    case "cleared":
      return initialState;
  }
}
