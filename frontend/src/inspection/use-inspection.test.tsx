// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { controlledRun } from "../../tests/ui/controlled-run";
import { errorBody, fileOfSize, makeReport, OVER_LIMIT, pdf, REQUEST_ID } from "../../tests/ui/builders";
import { interpretResponse } from "@/api/read-response";
import type { InspectionResult } from "@/api/client";
import { useInspection } from "./use-inspection";

const report = (name: string): InspectionResult => ({
  kind: "report",
  report: makeReport({ overrides: { document: { ...makeReport().document, filename: name } } }),
  requestId: REQUEST_ID,
});

function setup() {
  const control = controlledRun();
  const hook = renderHook(() => useInspection(control.run));
  return { ...control, hook, current: () => hook.result.current };
}

describe("a valid file", () => {
  it("goes from idle to running to succeeded", async () => {
    const { current, calls, run } = setup();
    expect(current().state).toEqual({ status: "idle" });

    const file = pdf("a.pdf");
    act(() => current().select([file]));
    expect(current().state).toEqual({ status: "running", file });
    expect(run).toHaveBeenCalledTimes(1);

    await act(async () => calls[0]!.resolve(report("a.pdf")));
    expect(current().state).toMatchObject({ status: "succeeded", fileName: "a.pdf" });
  });

  it("sends the file once, with a live abort signal", () => {
    const { current, calls } = setup();
    const file = pdf();
    act(() => current().select([file]));
    expect(calls[0]!.file).toBe(file);
    expect(calls[0]!.signal.aborted).toBe(false);
  });

  it("ignores an empty selection (a cancelled file dialog)", () => {
    const { current, run } = setup();
    act(() => current().select([]));
    expect(current().state).toEqual({ status: "idle" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("a file that is refused before upload", () => {
  it.each([
    ["not a PDF", fileOfSize("a.png", "image/png", 10), "not_pdf"],
    ["empty", fileOfSize("a.pdf", "application/pdf", 0), "empty"],
    ["over 10 MiB", fileOfSize("a.pdf", "application/pdf", OVER_LIMIT), "too_large"],
  ])("%s is rejected without a request", (_label, file, problem) => {
    const { current, run } = setup();
    act(() => current().select([file]));
    expect(current().state).toMatchObject({ status: "rejected", problem, fileName: file.name });
    expect(run).not.toHaveBeenCalled();
  });

  it("several files are rejected as a group", () => {
    const { current, run } = setup();
    act(() => current().select([pdf("a.pdf"), pdf("b.pdf")]));
    expect(current().state).toMatchObject({ status: "rejected", problem: "multiple" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("failures", () => {
  it.each([
    ["an error from the service", interpretResponse(422, JSON.stringify(errorBody("NO_TEXT_LAYER")), REQUEST_ID), "api"],
    ["an unusable reply", interpretResponse(200, "<html>", null), "malformed"],
    ["no connection", { kind: "network" } as const, "network"],
    ["a timeout", { kind: "timeout" } as const, "timeout"],
  ])("%s becomes a failure, not a result", async (_label, result, kind) => {
    const { current, calls } = setup();
    act(() => current().select([pdf()]));
    await act(async () => calls[0]!.resolve(result));
    expect(current().state).toMatchObject({ status: "failed", failure: { kind } });
  });

  it("retries the same file", async () => {
    const { current, calls, run } = setup();
    const file = pdf();
    act(() => current().select([file]));
    await act(async () => calls[0]!.resolve({ kind: "network" }));
    expect(current().state.status).toBe("failed");

    act(() => current().retry());
    expect(current().state).toEqual({ status: "running", file });
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls[1]!.file).toBe(file);

    await act(async () => calls[1]!.resolve(report("drawing.pdf")));
    expect(current().state.status).toBe("succeeded");
  });

  it("has nothing to retry before any file was chosen", () => {
    const { current, run } = setup();
    act(() => current().retry());
    expect(run).not.toHaveBeenCalled();
    expect(current().state).toEqual({ status: "idle" });
  });
});

describe("repeated selection and stale requests", () => {
  it("shows only the newest file's result when an older one answers later", async () => {
    const { current, calls } = setup();
    act(() => current().select([pdf("first.pdf")]));
    act(() => current().select([pdf("second.pdf")]));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[1]!.signal.aborted).toBe(false);

    await act(async () => calls[1]!.resolve(report("second.pdf")));
    expect(current().state).toMatchObject({ status: "succeeded", fileName: "second.pdf" });

    // The first upload finally answers, after the second has already finished.
    await act(async () => calls[0]!.resolve(report("first.pdf")));
    expect(current().state).toMatchObject({ status: "succeeded", fileName: "second.pdf" });
  });

  it("ignores an older answer that arrives while the newer request is still running", async () => {
    const { current, calls } = setup();
    act(() => current().select([pdf("first.pdf")]));
    act(() => current().select([pdf("second.pdf")]));

    await act(async () => calls[0]!.resolve(report("first.pdf")));
    const { state } = current();
    if (state.status !== "running") throw new Error(`expected running, got ${state.status}`);
    expect(state.file.name).toBe("second.pdf");
  });

  it("ignores an older failure as well", async () => {
    const { current, calls } = setup();
    act(() => current().select([pdf("first.pdf")]));
    act(() => current().select([pdf("second.pdf")]));
    await act(async () => calls[0]!.resolve({ kind: "network" }));
    expect(current().state.status).toBe("running");
  });

  it("drops the pending request when an invalid file is chosen next", async () => {
    const { current, calls } = setup();
    act(() => current().select([pdf("first.pdf")]));
    act(() => current().select([fileOfSize("notes.txt", "text/plain", 5)]));
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(current().state).toMatchObject({ status: "rejected", fileName: "notes.txt" });

    await act(async () => calls[0]!.resolve(report("first.pdf")));
    expect(current().state).toMatchObject({ status: "rejected" });
  });

  it("clears the previous result as soon as another file is chosen", async () => {
    const { current, calls } = setup();
    act(() => current().select([pdf("first.pdf")]));
    await act(async () => calls[0]!.resolve(report("first.pdf")));
    expect(current().state.status).toBe("succeeded");

    act(() => current().select([pdf("second.pdf")]));
    expect(current().state.status).toBe("running");
  });

  it("starts a new request when the same file is chosen again", () => {
    const { current, calls, run } = setup();
    const file = pdf();
    act(() => current().select([file]));
    act(() => current().select([file]));
    expect(run).toHaveBeenCalledTimes(2);
    expect(calls[0]!.signal.aborted).toBe(true);
  });

  it("returns to idle on cancel, aborts the request and ignores its answer", async () => {
    const { current, calls } = setup();
    act(() => current().select([pdf()]));
    act(() => current().cancel());
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(current().state).toEqual({ status: "idle" });

    await act(async () => calls[0]!.resolve(report("drawing.pdf")));
    expect(current().state).toEqual({ status: "idle" });
    act(() => current().retry()); // nothing left to retry after a cancel
    expect(current().state).toEqual({ status: "idle" });
  });

  it("aborts the request when the screen goes away", () => {
    const { current, calls, hook } = setup();
    act(() => current().select([pdf()]));
    hook.unmount();
    expect(calls[0]!.signal.aborted).toBe(true);
  });
});
