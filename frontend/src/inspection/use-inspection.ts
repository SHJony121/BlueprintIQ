"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { runInspection, type InspectionResult, type RunInspection } from "@/api/client";
import { inspectionReducer, initialState, type InspectionAction } from "./state";
import type { ParsedRequirements } from "./requirements";
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
  const lastRequest = useRef<{ file: File; requirements: ParsedRequirements } | null>(null);
  const lastFile = useRef<File | null>(null);

  const abortCurrent = useCallback(() => {
    current.current?.controller.abort();
    current.current = null;
  }, []);

  const start = useCallback(
    (file: File, requirements: ParsedRequirements) => {
      abortCurrent();
      const id = ++lastId.current;
      const controller = new AbortController();
      current.current = { id, controller };
      lastFile.current = file;
      lastRequest.current = { file, requirements };
      dispatch({ type: "started", file, requirementsKey: requirements.key });
      void run(file, { signal: controller.signal, requirements: requirements.header }).then(
        (result) => {
          if (current.current?.id !== id) return; // superseded, cancelled or unmounted
          current.current = null;
          const action = toAction(file, result, requirements.key);
          if (action !== null) dispatch(action);
        },
      );
    },
    [run, abortCurrent],
  );

  /**
   * A file chosen or dropped: inspect it with the current requirements, or explain why it
   * cannot be. With invalid requirements (`null`) the file is kept and waits for them.
   */
  const select = useCallback(
    (files: readonly File[], requirements: ParsedRequirements | null) => {
      const choice = chooseFile(files);
      if (choice === null) return;
      if ("file" in choice) {
        if (requirements === null) {
          abortCurrent();
          lastFile.current = choice.file;
          lastRequest.current = null;
          dispatch({ type: "waiting", file: choice.file });
        } else {
          start(choice.file, requirements);
        }
        return;
      }
      abortCurrent();
      lastFile.current = null;
      lastRequest.current = null;
      dispatch({
        type: "rejected",
        fileName: choice.fileName,
        sizeBytes: choice.sizeBytes,
        problem: choice.problem,
      });
    },
    [start, abortCurrent],
  );

  /** The same inspection again, with the requirements it used. */
  const retry = useCallback(() => {
    if (lastRequest.current !== null) start(lastRequest.current.file, lastRequest.current.requirements);
  }, [start]);

  /** Inspect the file already chosen with (new) requirements. */
  const rerun = useCallback(
    (requirements: ParsedRequirements) => {
      if (lastFile.current !== null) start(lastFile.current, requirements);
    },
    [start],
  );

  const cancel = useCallback(() => {
    abortCurrent();
    lastFile.current = null;
    lastRequest.current = null;
    dispatch({ type: "cleared" });
  }, [abortCurrent]);

  useEffect(() => abortCurrent, [abortCurrent]);

  return { state, select, retry, rerun, cancel };
}

function toAction(file: File, result: InspectionResult, requirementsKey: string): InspectionAction | null {
  switch (result.kind) {
    case "report":
      return {
        type: "succeeded",
        file,
        report: result.report,
        requestId: result.requestId,
        requirementsKey,
      };
    case "error":
      return {
        type: "failed",
        file,
        requirementsKey,
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
        requirementsKey,
        failure: {
          kind: "malformed",
          status: result.status,
          problem: result.problem,
          requestId: result.requestId,
        },
      };
    case "network":
    case "timeout":
      return { type: "failed", file, requirementsKey, failure: { kind: result.kind } };
    case "aborted":
      return null;
  }
}
