# User-defined inspection requirements

A user can change the limits a drawing is inspected against and run (or rerun) the inspection on the same PDF. Nothing is stored: the requirements live in the page and travel with each request.

> The default values are **demonstration values, not engineering standards**.

## What can be set

| Requirement | Rule used | Outcomes |
|---|---|---|
| Minimum thickness (mm) | `THK-MIN-001`, range rule | pass / fail |
| Maximum diameter (mm) | `DIA-MAX-001`, range rule | pass / fail |
| Minimum and/or maximum length (mm) | `LEN-RANGE-001`, range rule | pass / fail |
| Material annotation required, with an optional exact code | `MAT-REQ-001`, required rule | pass / fail / missing |

Any limit may be left blank to skip that check; at least one requirement is needed. Thresholds are inclusive, non-negative decimals with at most 12 integer and 6 fractional digits (`3`, `2.35`; not `1e3`, `3,5`, `-1`). They stay exact decimal text from the form to the engine; there is no floating point on the way. A material code is 1 to 32 characters (`A-Z a-z 0-9 space . _ / -`), compared after trimming and upper-casing both sides, and it compares only what is written on the drawing; it does not judge whether the material is suitable.

Ambiguous and conflicting readings are never turned into a verdict: they stay `needs_review`, exactly as with the demonstration rules. A missing measurement is still `missing`.

## How the requirements travel

```
form ──parse/validate──▶ JSON ──percent-encode──▶ X-Inspection-Requirements ──▶ Next.js proxy ──▶ FastAPI
                                                   (PDF body is unchanged)      (length/ASCII check,   (full validation,
                                                                                 forwards verbatim)     builds a Ruleset)
```

* One optional request header, `X-Inspection-Requirements`: percent-encoded JSON, at most 2048 characters, `version: 1`, with only the fixed keys `min_thickness_mm`, `max_diameter_mm`, `min_length_mm`, `max_length_mm` and `material {required, code}`. Unknown keys are refused. It carries values only: never TOML, expressions or rule definitions.
* The PDF stays the raw request body, so streaming and the 10 MiB limit are unchanged. The proxy forwards the header only if it is printable ASCII and within the length bound; otherwise it answers `422 INVALID_REQUIREMENTS` and forwards nothing.
* The backend parses the header **after** reading the body (so an early answer cannot reset the upload connection), turns the values into the existing `RangeRule` / `RequiredRule` types (ruleset id `custom-requirements`, version `1`) and runs the same deterministic engine in the same worker. Problems are reported with fixed messages that never echo the input.
* No header: the startup ruleset (`demo-plate-part`) applies, so existing clients and the API contract are unchanged. The page sends no header while the form equals the demonstration values.
* Optional exact material code is the only engine change: `equals` on a material `RequiredRule` (mismatch is a `fail` with the evidence cited; conflicting or ambiguous readings are `needs_review`). It is also valid in a TOML ruleset.

## What the page guarantees

* Each result states which requirements it was produced with (`Requirements applied`, read from the report's ruleset and findings, not from the form).
* A result is shown only while the form still describes it. Editing a value, or making one invalid, hides findings, summary and drawing evidence at once and asks to run again; putting the values back shows the same result again.
* A new run uses the current form values, replaces the report as a whole (document identity, evidence boxes and finding selection are rebuilt from the new report), and a late answer to an earlier request is ignored.
* A file chosen while the form is invalid waits and is inspected when the values are fixed and the button is pressed.

## Limits

* Thresholds apply per measurement type, not per feature or component.
* Only the four requirements above; no tolerances, units other than mm, or arbitrary rules.
* The values are not saved, shared or remembered across reloads.
* The tests in this milestone cover validation, outcomes with different thresholds, missing and ambiguous readings, defaults, proxy forwarding and a browser run against the real backend. No new accuracy or performance claims are made.
