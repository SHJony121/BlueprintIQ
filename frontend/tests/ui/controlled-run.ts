import { vi } from "vitest";
import type { InspectionResult, RunInspection } from "@/api/client";

export interface PendingCall {
  file: File;
  signal: AbortSignal;
  /** Settle this request with any result, at any time (even after it was aborted). */
  resolve: (result: InspectionResult) => void;
}

/**
 * A stand-in for the upload function whose requests stay pending until the test settles
 * them, so tests decide the order in which responses arrive. It does not react to abort
 * on its own: a test can deliver a late answer to an abandoned request to prove it is
 * ignored. This is a UI-state tool; it says nothing about real network behaviour.
 */
export function controlledRun() {
  const calls: PendingCall[] = [];
  const run = vi.fn<RunInspection>(
    (file, { signal }) =>
      new Promise<InspectionResult>((resolve) => {
        calls.push({ file, signal, resolve });
      }),
  );
  return { run, calls };
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
