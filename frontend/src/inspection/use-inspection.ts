"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { runInspection, type InspectionResult, type RunInspection } from "@/api/client";
import { inspectionReducer, initialState, type InspectionAction } from "./state";
import { chooseFile } from "./validate-file";

/**
 * Owns the lifetime of inspection requests.
 *
 * At most one request is current. Starting another, selecting an invalid file, cancelling
 * or unmounting aborts the current one, and a response that arrives for any request other
 * than the current one is dropped (the id check below), so a slow earlier upload can
 * never overwrite what the user is looking at. Nothing is stored: the file and the report
 * live in React state only.
 */
export function useInspection(run: RunInspection = runInspection) {
  const [state, dispatch] = useReducer(inspectionReducer, initialState);
  const current = useRef<{ id: number; controller: AbortController } | null>(null);
  const lastId = useRef(0);
  const lastFile = useRef<File | null>(null);

  const abortCurrent = useCallback(() => {
    current.current?.controller.abort();
    current.current = null;
  }, []);

  const start = useCallback(
    (file: File) => {
      abortCurrent();
      const id = ++lastId.current;
      const controller = new AbortController();
      current.current = { id, controller };
      lastFile.current = file;
      dispatch({ type: "started", file });
      void run(file, { signal: controller.signal }).then((result) => {
        if (current.current?.id !== id) return; // superseded, cancelled or unmounted
        current.current = null;
        const action = toAction(file, result);
        if (action !== null) dispatch(action);
      });
    },
    [run, abortCurrent],
  );

  /** A file chosen or dropped: inspect it, or explain why it cannot be. */
  const select = useCallback(
    (files: readonly File[]) => {
      const choice = chooseFile(files);
      if (choice === null) return;
      if ("file" in choice) {
        start(choice.file);
        return;
      }
      abortCurrent();
      dispatch({
        type: "rejected",
        fileName: choice.fileName,
        sizeBytes: choice.sizeBytes,
        problem: choice.problem,
      });
    },
    [start, abortCurrent],
  );

  const retry = useCallback(() => {
    if (lastFile.current !== null) start(lastFile.current);
  }, [start]);

  const cancel = useCallback(() => {
    abortCurrent();
    lastFile.current = null;
    dispatch({ type: "cleared" });
  }, [abortCurrent]);

  useEffect(() => abortCurrent, [abortCurrent]);

  return { state, select, retry, cancel };
}

function toAction(file: File, result: InspectionResult): InspectionAction | null {
  switch (result.kind) {
    case "report":
      return {
        type: "succeeded",
        fileName: file.name,
        report: result.report,
        requestId: result.requestId,
      };
    case "error":
      return {
        type: "failed",
        file,
        failure: {
          kind: "api",
          status: result.status,
          code: result.code,
          message: result.message,
          requestId: result.requestId,
        },
      };
    case "malformed":
      return {
        type: "failed",
        file,
        failure: {
          kind: "malformed",
          status: result.status,
          problem: result.problem,
          requestId: result.requestId,
        },
      };
    case "network":
    case "timeout":
      return { type: "failed", file, failure: { kind: result.kind } };
    case "aborted":
      return null;
  }
}
