# CAD annotations (CAD-2A)

BlueprintIQ reads conventional CAD dimensions and tolerances from selectable-text PDFs and lists them **as written**. This is extraction only: nothing here is matched to a part feature, checked by a rule, or counted as a finding.

## What is read

Only a whole text line that matches one of these forms (decimal point, up to 6 integer and 4 fractional digits):

| Written | Kind | Reading |
|---|---|---|
| `2.7 ±0.1` | linear | nominal 2.7, upper +0.1, lower -0.1 |
| `3.7 +0/-0.2` | linear | nominal 3.7, upper 0, lower -0.2 |
| `Ø12`, `⌀12`, `Ø12 ±0.05` | diameter | nominal 12 (and tolerance) |
| `R1.5` | radius | nominal 1.5 |
| `75° ±0.5°` | angle | nominal 75 deg, ±0.5 deg (the degree sign is required on both) |
| `16` | linear, unclassified | only when the unit is known and the number is short |
| `Material: POM C noir`, `Matière: POM C noir` | material (existing labeled parser) | upper-cased value `POM C NOIR` |

Values are exact Decimals (strings in JSON, never floats); the tolerance keeps its signs. Each annotation keeps its original text, page and bounding box.

## Units

* `mm` written in the annotation (`16 mm`), or
* one explicit drawing note, `All dimensions are in millimeter` / `... in mm`, or its French form (`Toutes les dimensions sont en millimètres`), reported as `cad_unit_note`. Leading bullets or dashes and a trailing full stop are ignored, and one line may print both languages separated by `/` or `|`. Several notes count only if **every** one says millimetres; any other unit anywhere (`inches`, `pouces`, `centimètres`) means no unit is inherited. Or
* the degree sign for angles.

If a conflicting unit note exists (inches, centimetres, metres) or there is no note, no unit is inherited. A tolerance or symbol form without a unit is kept with its values but marked **ambiguous** (`missing_unit`); a bare number without a unit is not read at all.

## What is not guessed

* An unlabeled value is never a thickness, length or diameter (`association` is always `none`). CAD annotations are separate from `measurements`, so no rule sees them and they cannot produce pass or fail.
* A bare number is read only with unit evidence, at most 3 integer digits, no leading zero. Part numbers, dates, revision codes (`ABC-12345`, `2024-01-15`, `REV 3`), larger numbers and any labeled line are left alone.
* A lone `0` (typically half of a stacked tolerance) is kept as an ambiguous observation, never a 0 mm dimension. A zero with its own qualifier (`0 mm`, `0 ±0.1`, `R0`, `Ø0`, `0°`) is still read.
* A line with a strong signal (`±`, `Ø12`, `75°`, a lone `+0` or `-0.2`) that does not match a form is kept as an **ambiguous** observation with no values. A tolerance stacked on separate lines is therefore never joined to its nominal value.
* Angled text is skipped as in CAD-1 and cannot be read here.

## Report and UI

`cad_annotations` (list) and `cad_unit_note` are added to the report (additive; `schema_version` stays 1.0). The page shows a "CAD annotations" section after the extracted measurements, with each original text, reading, unit source, uncertainty and location. The drawing viewer, evidence boxes and selection are unchanged: CAD annotations get no overlay boxes yet.

## Limits

* Single-line forms, plus the stacked tolerance below; no stacked fractions, thread notes, GD&T frames, chained or ordinate dimensions, or comma decimals.
* Material: `Material:`, `Matière:` and the bilingual `Material / Matière:` (either order) are read when the value follows the colon **on the same line**. Other languages are not read.
* **Label and value on separate lines (CAD-2B.1):** a line that is only a material label (`Matière :`, `Material :`, `Matérial :`) takes the value from the **one** text line on its row, to its right and near (within about 5 label heights). The row test uses displayed geometry: the two centres must be within 40% of the smaller line height and each inside the other's vertical extent, so a bilingual block whose rows overlap in height is not crossed. Font sizes may differ. The value must read as a material by the usual rules (letters present, no colon, not a placeholder or an indirect phrase), and it must not also fit another material label. Any second line near on the row, a value below or left of the label, or an empty cell leaves the material without a value (`needs_review`). The value stays verbatim in `source` (extraction method `pdf_text_layer_row_association`, box of the value) and the label verbatim in `label_source`; no joined line is invented. A bilingual block that yields two different material texts is reported as "different material descriptions" whose equivalence is not verified: the outcome is `needs_review`, never a pass, and a person decides whether they describe the same material.
* A bare number is only a candidate dimension; a title-block value such as a sheet number could be listed as an unclassified dimension when a millimetre note exists.
* Verified only on generated synthetic drawings. The third-party SolidWorks drawing used for guidance is not stored here and its full annotation coverage is not claimed.
* **Stacked tolerance (CAD-2B.2):** a value with no tolerance of its own (`3.7`, `Ø12`, `R1.5`, with a known unit) takes a tolerance printed as two separate lines beside it (`+0` above, `-0.2` below). It is merged only if, in displayed space: exactly two fragment lines lie to its right within 1.5 line heights and within 1.2 heights of its vertical centre; the upper one's centre is above and the lower one's below the value's centre, about equally far (within half a height) and no more than 1.6 heights apart; their left edges align (within 0.6 fragment heights); the upper is `0` or `+N` and the lower is `0` or `-N` (an unsigned non-zero number has an unknown sign and is refused; two bare zeros say nothing); no other text lies in the area; and no other value could claim the same pair. Otherwise nothing is merged and the fragments stay ambiguous observations (a lone `0` is never a dimension). The value line stays verbatim in `source`, the two fragments verbatim in `tolerance_parts`, and `tolerance_source` is `stacked` (an inline `±` tolerance is `inline`). The unit is the value's own, never taken from the fragments. A reconstructed tolerance is still a CAD annotation: it is not a measurement and no rule evaluates it.
* The thresholds above are conservative guesses checked on generated layouts only; tolerances printed in other arrangements (side by side, behind a leader, below the value) are not reconstructed.
* **Second layout (lower deviation on the value's line):** some exports print `3.7 -0.2` as one line with the upper deviation raised above the lower one (`0` over `0.2`). The text layer reads the first row as a single line, so the words and their glyph boxes are taken from the PDF (never from string widths). A two-word line, a plain value and a lower deviation (`-N` or `0`), is merged when exactly one separate line of the same writing direction (`0` or `+N`) lies above it by 0.5 to 1.3 line heights with its digits starting where the lower deviation's digits start (within 0.3 line heights); the value needs the drawing's millimetre note; no other text lies within 0.3 line heights above and below the stack or 0.5 line heights beyond its ends; and no other line wants the same upper line. Positions are compared in the line's writing direction, so vertical text works and page rotation or cropping do not matter. The value and each deviation keep their own verbatim text and glyph box (`source` is the value word, `tolerance_parts` the upper line and the lower word). A line like this that cannot be paired is kept as an ambiguous observation, never as a parsed dimension.
* On one real drawing this layout reconstructs most stacks but leaves two adjacent vertical stacks, placed only a few points apart, ambiguous because each lies just inside the other's free area. That conservative result is intended.
* **Feature association (CAD-2B.3):** a separate step ties a verified annotation to the vector geometry it refers to; see [feature-association.md](feature-association.md). `association` on a CAD annotation itself stays `none`.
