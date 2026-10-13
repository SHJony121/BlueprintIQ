# Dimension-to-feature association (CAD-2B.3)

BlueprintIQ can tie a CAD dimension to the **vector geometry it refers to**, using only evidence in the PDF's drawing data. No AI, OCR, model or paid service is involved, and nothing is guessed from proximity.

> An association is a statement about the drawing's **graphics** (this arrow ends on that drawn circle), not about the part. It is not a measurement or a finding, no inspection rule uses it, and it can never produce a pass or fail.

## Pipeline

1. **Vector scan** (`extraction/vector_geometry.py`). PyMuPDF's drawing paths become primitives in page space (the same space as the text boxes, unrotated, origin top-left):
   * straight **line runs** (collinear, touching segments merged; dashed lines are kept apart because they are centre or hidden lines);
   * **circles and arcs**, from Bezier curves or from chains of short segments (at least five consecutive segments turning steadily by at most 0.6 rad per vertex, fitted to one circle within 1% of its radius). A coarse polygon (an octagon) is not called round;
   * **arrowheads**: a small closed triangle, alone or inside a longer polyline (the shape CAD exports use), or two short equal strokes meeting sharply (open "V");
   * **dots**: small filled circles (radius 3 pt or less) used as terminators.
   A page with more than 20,000 paths, 30,000 segments or 8,000 straight runs is reported as truncated and nothing is associated.
2. **Association** (`extraction/feature_association.py`), for each parsed CAD annotation with a location:

| Annotation | Evidence required for `verified` | Feature |
|---|---|---|
| `Ø` diameter | **Leader:** a line (up to three connected straight runs) starts at the text, ends in an arrowhead or dot, and the arrow tip lies on a circle's circumference (0.5 pt or 2% of the radius) with the last run passing through its centre. **Or** a dimension line beside the text passes through a circle's centre and has arrowheads on the circumference on opposite sides. | the circle |
| `R` radius | Same leader evidence, onto an **arc** (the tip must lie within the arc's span) or a circle. | the arc (or circle) |
| linear (plain, `±`, stacked) | A solid dimension line beside the text with two **neighbouring** terminators (arrowhead or dot) on it, each lying on its own extension line (perpendicular, 0.2 pt), the two extension lines being different. On a line shared by several dimensions the text belongs to the pair whose span it lies **inside** (exactly one); otherwise to the first or last pair when it lies beyond the first or last terminator on the continuation of the same drawn line. Inside outranks being on the continuation of another pair's line. Terminators drawn twice at the same place count once, and two texts assigned to the same pair leave both unresolved. | the two extension lines, plus a reference edge when an extension line ends exactly on one drawn edge (0.75 pt) |

3. **Unresolved** (supported kind, evidence missing or competing) always carries the reason: no leader at the text; a leader without an arrowhead; an arrowhead not on a circle along a radius; two different circles under the same arrowhead; no dimension line beside the text; a line without terminators on two extension lines; several equally fitting structures; another text on the same dimension line.
4. **Unsupported**: angle dimensions, and pages that were truncated.

Parsed annotations only are considered; an annotation that is already ambiguous (a lone `0`, an unread fragment) gets no association row.

## What the report contains

`feature_associations` (one per considered annotation, ids `A1`...) and `geometry_summary` (counts of what the scan found, so a reader can see its extent). Each association has `annotation_id`, `relation`, `status` (`verified` / `unresolved` / `unsupported`), for verified ones a `feature_id` (`G1`...; the same drawn feature gets the same id) and `feature` geometry, `evidence` geometry (text box, leader, dimension line, terminators) in page space, `candidates` (how many were examined, not a probability) and an `explanation`. Coordinates are in the same page space as every other evidence box, so crop and rotation are handled by the viewer exactly as for findings.

## Frontend

The CAD annotations section shows, per annotation, "Feature identified: ..." with the explanation, or "Association unresolved" / "not supported" with the reason. A verified association has **Show on drawing**: the feature is drawn thick and the supporting lines thinner (dashed), through PDF.js's own transform, only on the inspected document.

## Validation, reported separately

**Generated drawings (the tests).** Controlled PDFs cover a clear diameter, a radius, a linear dimension, competing and tangent circles, several views, missing or disconnected leaders, a leader with no arrowhead or one that misses the centre, polygonal circles and arcs, arrowheads inside the leader polyline, geometry fused into one path, a title-block symbol that must stay unused, rotated and cropped pages, and unchanged rule outcomes. They show the rules behave as designed on clean geometry. They are **not** evidence of accuracy on real CAD output.

**One real SolidWorks drawing** (local only, never stored in the repository; the first one tested). It has 27 triangular arrowheads, 7 dot terminators and arcs and circles only as polylines, but **no diameter or standalone radius dimension**, so categories A and B have **no real-world validation** (an arc with a radius leader exists, but its text is angled and carries a multiplier, which are not read). All 15 parsed annotations (13 before CAD-3, plus the two stacks it recovered) are `verified` linear associations, 0 unresolved. They were checked in a browser, not only through the API: at fit width and at 164% the overlay lines lie on the drawn ink (100% coverage along each line), the terminators lie on ink, and the text boxes contain text; for several of them the highlight was inspected by eye against the drawing. As a further consistency check, not used by the algorithm, each verified span is 5.65 to 5.68 pt per millimetre of its nominal value; that is consistent with correct pairing but is not proof of it. This is one drawing and proves nothing about others.

## Limits

* No diameter, radius or hole-like feature was available in a real drawing; those two categories rest on generated geometry only.
* Linear associations name extension lines, not part edges: edges are named only when an extension line ends exactly on one drawn segment that is not part of a dimension's own graphics (SolidWorks leaves a gap, so usually none is named). Evidence is the exact drawn segments: the dimension line shown is the span between its terminators, an extension line is the segment that starts at the dimension line (a collinear segment merely passing through is not used), and a reference edge is the single segment touched.
* Text far from the continuation of a dimension line, or between non-neighbouring terminators, stays unresolved. A text on the continuation of a line is tied to the end pair only if no other terminator lies between; two dimensions whose texts both sit beyond the same end are both left unresolved.
* Angular, ordinate, baseline-from-datum, chamfer and thread notes, curved or spline leaders, and leaders longer than three straight runs are not handled.
* A circle is a circle: it is never called a hole, a boss or any other part feature.
* The drawing's scale is unknown, so no number is compared with the geometry.
