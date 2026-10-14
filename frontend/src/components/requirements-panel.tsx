"use client";

import { useId } from "react";
import {
  DEMO_FORM,
  DEMO_NOTE,
  type FieldName,
  type RequirementsForm,
  type RequirementsResult,
} from "@/inspection/requirements";

interface RequirementsPanelProps {
  form: RequirementsForm;
  result: RequirementsResult;
  onChange: (form: RequirementsForm) => void;
  /** What the primary button does, or null when there is no file to inspect or it is running. */
  runLabel: string | null;
  onRun: () => void;
  /** Folded away while a current result is shown, so the results are not pushed below the fold. */
  collapsed?: boolean;
}

const LIMITS: { field: FieldName; label: string; hint: string }[] = [
  { field: "minThickness", label: "Minimum thickness (mm)", hint: "Each thickness must be at least this." },
  { field: "maxDiameter", label: "Maximum diameter (mm)", hint: "Each diameter must not exceed this." },
  { field: "minLength", label: "Minimum length (mm)", hint: "Each length must be at least this." },
  { field: "maxLength", label: "Maximum length (mm)", hint: "Each length must not exceed this." },
];

/**
 * The limits to inspect against. They start as the demonstration values and are only used
 * for an inspection when the button is pressed (or a file is chosen); changing them never
 * changes results already shown, which are hidden as out of date instead.
 */
export function RequirementsPanel({ form, result, onChange, runLabel, onRun, collapsed = false }: RequirementsPanelProps) {
  const id = useId();
  const isDemo = result.ok && result.isDemo;
  const set = <K extends FieldName>(field: K, value: RequirementsForm[K]) => onChange({ ...form, [field]: value });
  const errors = result.ok ? {} : result.errors;

  return (
    <details open={!collapsed} className="mt-4 rounded-md border border-line bg-surface">
      <summary className="cursor-pointer px-4 py-3 text-base font-semibold">
        Inspection requirements{" "}
        <span className="font-normal text-muted">
          ({isDemo ? "demonstration values" : "custom values"}; open to change them)
        </span>
      </summary>
      <div className="border-t border-line px-4 py-4">
        <p data-testid="requirements-label" className="text-sm font-medium">
          {isDemo ? DEMO_NOTE : "Custom requirements. Edited from the demonstration values."}
        </p>
        <p className="mt-1 text-sm text-muted">
          Leave a limit blank to skip that check. Thresholds are in millimetres and inclusive.
        </p>
        <div className="mt-3 grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-4">
          {LIMITS.map(({ field, label, hint }) => (
            <div key={field} className="flex flex-col gap-1">
              <label htmlFor={`${id}-${field}`} className="text-sm font-medium">
                {label}
              </label>
              <input
                id={`${id}-${field}`}
                name={field}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                value={form[field] as string}
                onChange={(event) => set(field, event.currentTarget.value)}
                aria-invalid={errors[field] !== undefined}
                aria-describedby={`${id}-${field}-help`}
                className="rounded-md border border-line bg-background px-3 py-1.5 font-mono text-sm aria-invalid:border-fail"
              />
              <p id={`${id}-${field}-help`} className={`text-xs ${errors[field] ? "text-fail" : "text-muted"}`}>
                {errors[field] ?? hint}
              </p>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={form.materialRequired}
              onChange={(event) => set("materialRequired", event.currentTarget.checked)}
              className="accent-[var(--accent)]"
            />
            Require a material annotation
          </label>
          <div className="ml-6 flex max-w-xs flex-col gap-1">
            <label htmlFor={`${id}-code`} className="text-sm">
              Required material code (optional)
            </label>
            <input
              id={`${id}-code`}
              name="materialCode"
              type="text"
              autoComplete="off"
              spellCheck={false}
              disabled={!form.materialRequired}
              value={form.materialCode}
              onChange={(event) => set("materialCode", event.currentTarget.value)}
              aria-invalid={errors.materialCode !== undefined}
              aria-describedby={`${id}-code-help`}
              className="rounded-md border border-line bg-background px-3 py-1.5 font-mono text-sm disabled:opacity-50 aria-invalid:border-fail"
            />
            <p id={`${id}-code-help`} className={`text-xs ${errors.materialCode ? "text-fail" : "text-muted"}`}>
              {errors.materialCode ??
                "Blank checks only that a material is written. A code such as SS400 must match exactly."}
            </p>
          </div>
        </div>
        {errors.form !== undefined ? (
          <p role="alert" className="mt-3 text-sm font-medium text-fail">
            {errors.form}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onRun}
            disabled={runLabel === null || !result.ok}
            className="rounded-md bg-accent px-4 py-1.5 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {runLabel ?? "Run inspection"}
          </button>
          <button
            type="button"
            onClick={() => onChange(DEMO_FORM)}
            disabled={isDemo}
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm font-medium hover:border-accent disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reset to demonstration values
          </button>
          {runLabel === null ? (
            <span className="text-sm text-muted">Choose a PDF first.</span>
          ) : !result.ok ? (
            <span className="text-sm text-muted">Fix the highlighted values to run the inspection.</span>
          ) : null}
        </div>
      </div>
    </details>
  );
}
