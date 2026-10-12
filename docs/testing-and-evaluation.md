# Testing and evaluation

Everything on this page was measured by tests or scripts that were actually run. Nothing is estimated. Where something has **not** been measured, it says so.

## 1. Test suite (1134 tests; the count was 1132 when this section was written and includes 2 OpenAPI snapshot tests added in Phase 2A)

All pass locally (Windows) and in GitHub Actions (Linux, Python 3.13): `ruff check`, `ruff format --check`, `mypy --strict` (24 source files), `pytest`. On Windows 3 tests are skipped because they need Linux's memory limit (they run on Linux CI).

| Area | Tests | What they cover |
|---|---|---|
| Units | 39 | Exact conversion (mm, cm, m, in), strict spellings, errors |
| Models | 169 | Geometry, measurements, findings, report invariants, JSON round trip |
| Annotation parser | 365 | Supported grammar, ambiguity, false-positive prevention, robustness |
| Geometry and segmentation | 24 | Page/viewer mapping (checked against PyMuPDF), gap splitting |
| Rules config | 56 | Valid and invalid TOML, Decimal exactness, error messages |
| Rules engine | 81 | Boundaries, conflicts, duplicates, ordering, wording, evidence |
| Integration (PDF → report) | 331 | Extraction vs ground truth, rejection codes, robustness, rule outcomes per fixture |
| API and worker isolation | 64 | Upload limits, errors, timeouts, crashes, concurrency, logging |
| Other | 3 | Smoke, fixture determinism |

## 2. Synthetic fixtures and ground truth

`backend/scripts/generate_fixtures.py` writes **32 deterministic PDFs** (22 valid drawings, 10 that must be refused) and their expected results. The PDFs come from a dependency-free writer (`tests/fixtures/synthetic_pdf.py`) that places every text run with explicit PDF operators.

**Ground truth is independent of the code under test:** expected text, order, page geometry, measurements and rule outcomes are written by hand (`drawing_specs.py`, `expected_findings.py`); expected bounding boxes are computed from PDF geometry and published Adobe font widths, never from PyMuPDF or BlueprintIQ. A test fails if the committed fixtures differ from what the generator produces.

Fixture coverage: valid values; every unit; boundary and precision values; multiple, duplicate and conflicting annotations; ambiguous and unsupported annotations; a specification limit; missing material; rotations 0/90/180/270 (upright and sideways text); offset, inherited and oversized crop boxes; split text spans; annotations too close to separate; hidden, invisible, tiny and clipped text; and refused files (multi-page, no text, partly visible, partly clipped, crop-edge glyph, `/Rotate 135`, OCR-only layer, `/UserUnit`, slanted text).

## 3. Results measured on the synthetic fixtures

* **Extraction (M3 test run):** all 22 valid fixtures match the expected text and order (122 lines), page geometry, hidden-line counts and all 89 expected measurements. All 10 refused fixtures are refused with the expected code.
* **Bounding boxes:** along the writing direction, every edge is within 0.0001 pt of the position predicted from font metrics; across it, boxes extend 0.9–3.6 pt beyond the glyph ink (font ascender/descender space).
* **Rule outcomes (M4):** all 22 valid fixtures produce exactly the hand-written expected findings.
* **Exhaustive uncertainty check:** every mix of passing, failing and unreadable thickness annotations (1–3 annotations) is evaluated; none yields a pass or fail unless all are readable and equal.
* **Exactness:** a value of `50.0000000000000001` against a 50 mm maximum fails, although it equals 50 as a binary float.
* **Mutation checks (one-off runs):** M3 safeguards (39) and M4 rules (32) were each deliberately broken once; a test failed every time, except four M3 safeguards that are backed by a second, independent check.
* **Fuzzing (one-off run):** 300,000 random labeled lines through the parser: no crashes, no suspicious parses.
* **Latency:** about 1.2 s per inspection on the development machine (Windows), mostly worker start-up; measured over three requests, not a benchmark.

These are correctness results on controlled inputs. They are **not** accuracy estimates.

## 4. Independent reviews

Each milestone's riskiest code was reviewed by separate reviewer agents (parser, PDF extraction, rules engine, API security); confirmed defects were fixed with regression tests and re-verified. The history is in the commit messages and spec sections 14–17.

## 5. What is not established

* **Real-world CAD performance is unverified.** No real industrial drawing has been processed. Real exports differ from the synthetic ones (embedded and CID fonts, per-glyph positioning, Type 3 fonts, hatch and viewport clips, annotations as separate text objects).
* **No precision/recall, accuracy percentage, cost or user data exists**, and none is claimed.
* **Memory-limit behaviour on Windows** is not enforced.
* **Throughput under load** has not been measured.

## Limitations

**Unsupported inputs** (refused with a typed error): scanned/OCR-only PDFs, multi-page PDFs, encrypted PDFs, damaged or repaired PDFs, text at angles other than multiples of 90°, `/Rotate` not a multiple of 90, `/UserUnit` scaling, text partly cut off by the crop box or a clip, over-complex pages. DWG and other formats are out of scope.

**Supported annotations only:** English `THICKNESS`, `DIAMETER`, `LENGTH`, `MATERIAL` followed by a plain number and unit (`mm`, `cm`, `m`, `in`; uppercase `MM`, `CM`, `IN` accepted) or a material name. No `Ø`, tolerances, ranges, thread sizes or Japanese labels.

**False positives and uncertainty (by design, conservative):**

* Anything unusual is flagged `needs_review` rather than parsed; legitimate unusual notation will therefore be flagged (e.g. a material followed by `PER JIS …`, a line such as `(MIN) THICKNESS: 5 mm`, annotations closer than about 2 em that cannot be separated).
* The material check is a word list; it cannot detect two bare grades with no separator (`SS400 SUS304`), and a font that maps a glyph to a different character is trusted.
* Clip handling is conservative: a clip whose scope has already ended can still cause a refusal, so CAD sheets with viewport or hatch clips near annotations may be refused.
* Rules apply per measurement type, not per feature; the engine cannot tell which hole a diameter belongs to.
* A passing `required` material rule means "an annotation is present", never that the material is suitable.
* Thresholds are demonstration values, not standards.
