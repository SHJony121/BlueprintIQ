import type { InspectionReport } from "@/api/types";
import { DEMO_NOTE } from "@/inspection/requirements";

/**
 * Which requirements this result was produced with, read from the report itself (the
 * ruleset and the rules of its findings), never from the form: the form can change after
 * a result is shown, the report cannot.
 */
export function AppliedRequirements({ report }: { report: InspectionReport }) {
  const { id, version } = report.ruleset;
  const label =
    id === "demo-plate-part"
      ? DEMO_NOTE
      : id === "custom-requirements"
        ? "Your requirements, set for this inspection."
        : `Ruleset ${id} ${version}.`;
  const rules = new Map<string, string>();
  for (const finding of report.findings) {
    if (!rules.has(finding.rule_id)) rules.set(finding.rule_id, finding.rule_description);
  }
  return (
    <section aria-labelledby="applied-heading" data-testid="applied-requirements">
      <h3 id="applied-heading" className="text-base font-semibold">
        Requirements applied
      </h3>
      <p className="mt-1 text-sm text-muted">{label}</p>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {[...rules].map(([ruleId, description]) => (
          <li key={ruleId}>
            <span className="font-mono font-medium">{ruleId}</span> {description}
          </li>
        ))}
      </ul>
    </section>
  );
}
