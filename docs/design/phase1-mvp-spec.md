# BlueprintIQ — Phase 1 MVP Design

| | |
|---|---|
| **Status** | Approved with amendments (see §12) — 2026-10-12 |
| **Date** | 2026-10-12 |
| **Scope** | Backend only: upload PDF → extract → validate → evaluate rules → findings with evidence |
| **Out of scope** | Frontend, VLM/LLM, persistence, Docker, benchmarks (all later phases) |

---

## 1. Shared understanding

**What you specified**

- A real, interview-defensible engineering project — not an LLM wrapper.
- Phase 1 = smallest reliable end-to-end backend: single-page, vector/text PDFs; synthetic drawings; explicitly labeled annotations (`THICKNESS: 4 mm`, `DIAMETER: 20 mm`, `MATERIAL: SS400`); deterministic extraction and rules.
- Every measurement carries id, type, raw text, value, unit, normalized value, page, bbox, extraction method, status.
- Rule outcomes distinguish **pass / fail / missing / needs review**. Uncertain extractions must never become confirmed violations.
- Rules: minimum thickness, maximum diameter, required material, missing info, basic range. Thresholds are demonstration values, configurable.
- Safe uploads: size, type, parse errors, page count, temp files, no leaked internals.
- Priority: correctness → traceability → testing → maintainability → UX → advanced AI.

**What I am assuming (please correct any of these)**

| # | Assumption | Why |
|---|---|---|
| A1 | Rules apply **per measurement type**, not per component. No "which hole is this diameter for?" association in Phase 1. | Component association needs geometry inference, which is explicitly out of scope. |
| A2 | Supported units: `mm`, `cm`, `m`, `in`. Everything normalizes to **mm**. | Covers the unit-conversion fixtures without inviting ambiguity (`"` for inch, `ft`, etc.). |
| A3 | One ruleset is loaded at startup from a file. No per-request rule upload. | YAGNI — the API stays small; rules are still configurable. |
| A4 | The API is **stateless**: `POST` returns the full report. No database yet. | You said "SQLite only when persistence is actually needed". Nothing in Phase 1 needs it. |
| A5 | English uppercase labels only. Japanese labels (e.g. 板厚, 材質) are a later, additive extension. | Keeps the grammar small and testable; the parser design allows adding aliases. |

---

## 2. MVP specification

**Input:** one PDF file via HTTP multipart upload.

**Accepted:** a valid, unencrypted PDF with exactly 1 page that has an extractable text layer, ≤ 10 MiB.

**Output:** an `InspectionReport` JSON containing:
1. document info (SHA-256, size, page geometry) — so a report is traceable to the exact file inspected,
2. every recognized measurement with its source evidence (page + bbox + raw text),
3. labeled lines whose label is not supported (reported, never silently dropped),
4. one or more findings per rule, each with status, severity, the measurement(s) it used, expected constraint, actual value, and a deterministic explanation,
5. a status summary and the assistive-prototype disclaimer.

**Rejected with explicit error codes:** non-PDF, oversized, corrupted, encrypted, multi-page, and no-text-layer (likely scanned) files.

**Success definition for Phase 1:** every synthetic fixture produces exactly the hand-written expected measurements and findings, every invalid input produces its specific error code, and all checks run green in CI.

---

## 3. Architecture

### 3.1 Layers and data flow

```
           ┌──────────────────────────── api/ (G) ─────────────────────────────┐
 HTTP ───▶ │ size guard → type check → run pipeline on PDF worker → JSON / error │
           └───────────────────────────────┬──────────────────────────────────┘
                                           │ bytes
                    inspection.py (F) ─────┤ orchestrates; owns no logic of its own
                                           ▼
  ingestion/ (A)        extraction/ (B)            extraction/parser (D)        rules/ (E)
  open + validate  ──▶  text lines + bboxes  ──▶  grammar → typed, normalized ──▶ evaluate ──▶ findings
  (PyMuPDF)             (PyMuPDF, page coords)     measurements (pure, no PDF)    (pure)
```

Within `src/`, only A and B import PyMuPDF. (The fixture generator script also uses it, but it is not part of the package.)

| Layer | Module | Depends on | Pure? | Test style |
|---|---|---|---|---|
| A Ingestion | `ingestion/pdf_loader.py` | PyMuPDF | no | integration (generated bad PDFs) |
| B Text extraction | `extraction/text_layer.py` | PyMuPDF, A | no | integration (fixture PDFs) |
| C VLM | — | — | — | **not in Phase 1**; slot reserved by `extraction_method` field |
| D Parse + normalize | `extraction/annotation_parser.py`, `domain/units.py` | domain models | **yes** | unit, table-driven |
| E Rules | `rules/config.py`, `rules/engine.py` | domain models | **yes** | unit, table-driven |
| F Findings/report | `inspection.py` | A, B, D, E | no | integration |
| G API | `api/` | F | no | API tests via `TestClient` |

The key boundary: **layers D and E never see a PDF**. They operate on strings and Pydantic models, so most correctness tests are fast, deterministic, and independent of PyMuPDF. PyMuPDF is confined to two files — which also keeps the option open to swap it (see §11, licensing).

### 3.2 Key decisions and trade-offs

**D1 — Deterministic text-layer extraction, no AI in Phase 1.**
Vector PDFs exported from CAD already contain the text with exact coordinates. Reading it directly is exact, free, fast, and reproducible. A VLM would add cost, nondeterminism, and hallucination risk to a problem that doesn't need it yet. AI enters later only where text extraction genuinely can't reach (scans, unlabeled dimensions).

**D2 — `Decimal` arithmetic for values and thresholds.**
With floats, `0.3 cm → 3.0000000000000004 mm`, which can flip a boundary check. Boundary values are an explicit fixture category, so comparisons use `Decimal` (1 in = 25.4 mm exactly). JSON output serializes these as numbers for client convenience.

**D3 — Two separate status levels.**
*Extraction status* (`parsed` / `ambiguous`) describes how trustworthy a value is. *Finding status* (`pass` / `fail` / `missing` / `needs_review`) describes the rule outcome. The engine enforces one invariant: **`fail` can only be produced from a `parsed` measurement.** Ambiguous input yields `needs_review`, never a violation.

**D4 — Stateless API.**
No DB, no file storage, no cleanup jobs. Each request is processed **in memory** (`pymupdf.open(stream=bytes)`) — no temp files are written by our code, which removes a whole class of temp-file security problems.

**D5 — PyMuPDF runs on a single dedicated worker thread.**
PyMuPDF's docs state it does not support multithreaded use (it can crash the interpreter). FastAPI runs blocking work in a thread pool, so concurrent requests would violate that. Phase 1 routes all PDF work through a `ThreadPoolExecutor(max_workers=1)`: correct, simple, and fine for local use. Trade-off: PDF processing is serialized. The later upgrade is a process pool, which also isolates crashes from malformed PDFs and allows hard timeouts. The pipeline is a plain function `bytes → report`, so this is an API-layer swap only.

**D6 — Rules in TOML, validated by Pydantic.**
`tomllib` is in the standard library (no dependency), TOML is strict (no YAML-style surprises like `NO → false`), and it reads well for engineers. Pydantic validates the loaded structure, so a bad rules file fails at startup with a clear message — not mid-request.

**D7 — `src/` layout and a `backend/` subfolder.**
`backend/` leaves room for `frontend/` later. The `src/` layout guarantees tests run against the installed package, not accidental imports from the working directory.

### 3.3 Coordinate convention (and future PDF.js mapping)

- **PyMuPDF space (stored):** origin at the **top-left** of the page, y grows **downward**, units are **points** (1/72 inch). `get_text()` coordinates refer to the **unrotated** page — confirmed in PyMuPDF docs; only `page.rect` reflects rotation.
- **API:** `bbox = {x0, y0, x1, y1}` in that space; `page_number` is **1-based** (PyMuPDF index + 1). `PageInfo` reports unrotated `width_pt`, `height_pt`, and `rotation`.
- **PDF.js (frontend phase):** PDF.js viewports take **PDF user space** (origin bottom-left, y up) and apply scale and `/Rotate` themselves. For a page whose box origin is (0, 0): `pdfRect = [x0, H − y1, x1, H − y0]`, then convert with the viewport's rectangle conversion. For pages with a non-zero CropBox origin, compute the PDF rect server-side with `rect * ~page.transformation_matrix`.
- **Phase 1 guarantee:** all fixtures use rotation 0 and a box origin of (0, 0). The general mapping (rotated or cropped pages) gets its own test in the frontend phase, verified against current PDF.js docs.

---

## 4. Repository structure (Phase 1 only)

```
BlueprintIQ/
├── .github/workflows/backend-ci.yml      # lint, format check, type check, tests
├── backend/
│   ├── pyproject.toml                    # deps + ruff/mypy/pytest config
│   ├── uv.lock                           # reproducible environment
│   ├── rules/demo_rules.toml             # demonstration thresholds (not standards)
│   ├── scripts/generate_fixtures.py      # builds synthetic PDFs + ground truth
│   ├── src/blueprintiq/
│   │   ├── __init__.py
│   │   ├── config.py                     # settings (env-overridable limits/paths)
│   │   ├── logging_setup.py              # JSON log formatter
│   │   ├── domain/models.py              # all Pydantic schemas
│   │   ├── domain/units.py               # Decimal unit normalization
│   │   ├── ingestion/pdf_loader.py       # (A) validate + open
│   │   ├── extraction/text_layer.py      # (B) lines + bboxes
│   │   ├── extraction/annotation_parser.py  # (D) grammar → measurements
│   │   ├── rules/config.py               # (E) TOML → validated Ruleset
│   │   ├── rules/engine.py               # (E) measurements × rules → findings
│   │   ├── inspection.py                 # (F) pipeline: bytes → InspectionReport
│   │   └── api/{app.py, errors.py, limits.py}  # (G)
│   └── tests/
│       ├── unit/          # units, parser, rule config, rule engine
│       ├── integration/   # PDF extraction + full pipeline vs ground truth
│       ├── api/           # HTTP contract + error handling
│       └── fixtures/{drawings/*.pdf, expected/*.json, rules/test_rules.toml}
├── docs/design/phase1-mvp-spec.md        # this document
├── README.md
└── .gitignore / .gitattributes
```

About 15 source files and 8 test files. Files are added milestone by milestone, not all at once.

---

## 5. Initial Pydantic schemas (sketch — Pydantic v2)

```python
Quantity = Annotated[Decimal, PlainSerializer(float, return_type=float, when_used="json")]

class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

class LengthUnit(StrEnum):      MM = "mm"; CM = "cm"; M = "m"; IN = "in"
class DimensionType(StrEnum):   THICKNESS = "thickness"; DIAMETER = "diameter"; LENGTH = "length"
class ExtractionStatus(StrEnum):
    PARSED = "parsed"           # matched a supported format completely
    AMBIGUOUS = "ambiguous"     # label recognized, value/unit not trustworthy
class ExtractionIssue(StrEnum):
    MISSING_VALUE = "missing_value"; MISSING_UNIT = "missing_unit"
    UNSUPPORTED_UNIT = "unsupported_unit"; DECIMAL_COMMA = "decimal_comma"
    UNSUPPORTED_SYNTAX = "unsupported_syntax"     # e.g. tolerances "100 ± 0.5 mm"

class BBox(_Frozen):            # PyMuPDF page space, points; validator: x0 ≤ x1, y0 ≤ y1
    x0: float; y0: float; x1: float; y1: float

class SourceEvidence(_Frozen):
    page_number: int = Field(ge=1)
    bbox: BBox
    raw_text: str                                   # exact line text, e.g. "THICKNESS: 4 mm"
    extraction_method: Literal["pdf_text_layer"]    # later: "vlm", "human"

class DimensionMeasurement(_Frozen):
    kind: Literal["dimension"] = "dimension"
    id: str                                         # "M1", "M2", … in reading order
    dimension_type: DimensionType
    value: Quantity | None                          # as written, e.g. 0.5
    unit: LengthUnit | None                         # as written, e.g. cm
    normalized_value_mm: Quantity | None            # e.g. 5
    status: ExtractionStatus
    issues: tuple[ExtractionIssue, ...] = ()
    source: SourceEvidence
    # model_validator: PARSED ⇔ (value, unit, normalized_value_mm all set AND issues empty)

class MaterialAnnotation(_Frozen):
    kind: Literal["material"] = "material"
    id: str
    value: str | None                               # normalized: trimmed, upper-case ("SS400")
    status: ExtractionStatus
    issues: tuple[ExtractionIssue, ...] = ()
    source: SourceEvidence
    # model_validator: PARSED ⇔ (value set AND issues empty)

Measurement = Annotated[DimensionMeasurement | MaterialAnnotation, Field(discriminator="kind")]

class UnrecognizedAnnotation(_Frozen):              # "HARDNESS: 200 HB" — labeled but unsupported
    label: str
    source: SourceEvidence

class FindingStatus(StrEnum):   PASS = "pass"; FAIL = "fail"; MISSING = "missing"; NEEDS_REVIEW = "needs_review"
class Severity(StrEnum):        ERROR = "error"; WARNING = "warning"; INFO = "info"

class Finding(_Frozen):
    id: str                                         # "F1", …
    rule_id: str                                    # "THK-MIN-001"
    status: FindingStatus
    severity: Severity                              # from the rule
    measurement_ids: tuple[str, ...]                # empty only when status == MISSING
    expected: str                                   # "≥ 3 mm", "10 mm – 500 mm", "present"
    actual: str | None                              # "2 mm", "5 mm (0.5 cm)", None when missing
    message: str                                    # deterministic template, no LLM

class PageInfo(_Frozen):        page_number: int; width_pt: float; height_pt: float; rotation: Literal[0, 90, 180, 270]
class DocumentInfo(_Frozen):    filename: str | None; sha256: str; size_bytes: int; page_count: int; pages: tuple[PageInfo, ...]
class RulesetInfo(_Frozen):     id: str; version: str
class FindingSummary(_Frozen):  passed: int; failed: int; missing: int; needs_review: int

class InspectionReport(_Frozen):
    schema_version: Literal["1.0"] = "1.0"
    document: DocumentInfo
    ruleset: RulesetInfo
    measurements: tuple[Measurement, ...]
    unrecognized_annotations: tuple[UnrecognizedAnnotation, ...]
    findings: tuple[Finding, ...]
    summary: FindingSummary
    processing_time_ms: float
    disclaimer: str
```

Design notes: the discriminated union means material never carries a meaningless unit field. Validators make invalid states unrepresentable — for example, a "parsed" measurement with no value cannot be constructed. `filename` is the sanitized basename only.

---

## 6. API design

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness: `{"status": "ok"}` |
| `GET` | `/api/v1/rules` | The active ruleset (id, version, rules), so clients can show what was checked |
| `POST` | `/api/v1/inspections` | Multipart field `file` (PDF) → `200 InspectionReport` |

OpenAPI docs are auto-generated at `/docs`.

**Error envelope (every non-2xx response):**
```json
{ "error": { "code": "FILE_TOO_LARGE", "message": "Upload exceeds the 10 MiB limit.", "request_id": "3f2a…" } }
```

| HTTP | `code` | Trigger |
|---|---|---|
| 413 | `FILE_TOO_LARGE` | Over `MAX_UPLOAD_BYTES`. Rejected early from `Content-Length`, re-checked while counting the body. |
| 415 | `UNSUPPORTED_FILE_TYPE` | Content does not start with `%PDF-` (the client's content-type is not trusted) |
| 422 | `EMPTY_FILE` | Zero bytes |
| 422 | `INVALID_PDF` | PyMuPDF cannot open or parse it |
| 422 | `ENCRYPTED_PDF` | Password-protected |
| 422 | `TOO_MANY_PAGES` | `page_count > MAX_PAGES` (Phase 1: 1) |
| 422 | `NO_TEXT_LAYER` | No extractable text — likely a scan. Rejected instead of returning a misleading "all missing" report. |
| 422 | `REQUEST_VALIDATION_ERROR` | Missing or extra form field (FastAPI validation, re-wrapped into the envelope) |
| 500 | `INTERNAL_ERROR` | Anything unexpected. Generic message only; details are logged server-side under the `request_id`. |

**Security and resource rules**
- Error bodies never contain stack traces, file system paths, exception text from libraries, or document content.
- An `X-Request-ID` header goes on every response, and the same id appears in the logs.
- Logs record SHA-256 prefix, size, counts, and duration — never document text or the full filename.
- Settings (env prefix `BLUEPRINTIQ_`): `MAX_UPLOAD_BYTES=10485760`, `MAX_PAGES=1`, `RULESET_PATH`, `LOG_LEVEL`.
- Known limitation: there is no per-request processing timeout in Phase 1. It arrives with the process pool (D5). In production, the reverse proxy should also enforce body size.

---

## 7. Rule format

`backend/rules/demo_rules.toml`:

```toml
[ruleset]
id = "demo-plate-part"
version = "0.1.0"
description = "Demonstration thresholds only. Not an industry or company standard."

[[rules]]
id = "THK-MIN-001"
kind = "range"
applies_to = "thickness"
min_mm = 3.0
severity = "error"
description = "Plate thickness must be at least 3 mm."

[[rules]]
id = "DIA-MAX-001"
kind = "range"
applies_to = "diameter"
max_mm = 50.0
severity = "error"
description = "Hole diameter must not exceed 50 mm."

[[rules]]
id = "LEN-RANGE-001"
kind = "range"
applies_to = "length"
min_mm = 10.0
max_mm = 500.0
severity = "warning"
description = "Overall length must be between 10 mm and 500 mm."

[[rules]]
id = "MAT-REQ-001"
kind = "required"
applies_to = "material"
severity = "error"
description = "A material specification must be present."
```

There are only **two rule kinds**. `range` covers minimum, maximum, and bounded range (bounds are **inclusive**). `required` covers "required material" and "missing required information" for any field.

**Evaluation semantics (the core of correctness):**

| Rule kind | Measurements of `applies_to` on the drawing | Finding(s) |
|---|---|---|
| `range` | none | 1 × `missing` |
| `range` | each `parsed` measurement | `pass` if `min ≤ v ≤ max`, else `fail` (one finding per measurement) |
| `range` | each `ambiguous` measurement | `needs_review` (one per measurement) |
| `required` | ≥ 1 `parsed` | 1 × `pass` |
| `required` | 0 `parsed`, ≥ 1 `ambiguous` | 1 × `needs_review` |
| `required` | none | 1 × `missing` |

Every rule produces at least one finding, so a report always shows that every rule was evaluated.

**Config validation (fails at startup):** duplicate rule ids; `range` with no bounds or with `min_mm > max_mm`; bounds on a `material` rule; unknown `kind`, `applies_to`, or `severity`; any unknown key (`extra="forbid"`).

---

## 8. Annotation grammar, testing strategy, and synthetic fixtures

### 8.1 Phase 1 annotation grammar

A line qualifies only if it **starts** with `LABEL:` (case-insensitive, whitespace-tolerant). Supported labels: `THICKNESS`, `DIAMETER`, `LENGTH`, `MATERIAL`. Numbers are `digits[.digits]` — no sign, no exponent.

| Input line | Result |
|---|---|
| `THICKNESS: 4 mm` / `thickness:4MM` | parsed, 4 mm → 4 mm |
| `THICKNESS: 0.5 cm` | parsed, 0.5 cm → 5 mm |
| `DIAMETER: 2 in` | parsed, 2 in → 50.8 mm |
| `THICKNESS: 4` | ambiguous · `missing_unit` |
| `THICKNESS: 4 ft` | ambiguous · `unsupported_unit` |
| `DIAMETER: 2,5 mm` | ambiguous · `decimal_comma` (2.5 or 25? — refuse to guess) |
| `LENGTH: 100 ± 0.5 mm` | ambiguous · `unsupported_syntax` |
| `THICKNESS:` / `MATERIAL:` | ambiguous · `missing_value` |
| `THICKNESS: about four` (any other value text) | ambiguous · `unsupported_syntax` (catch-all) |
| `MATERIAL: ss400` | parsed, `SS400` |
| `HARDNESS: 200 HB` | unrecognized annotation (reported, not evaluated) |
| `Ø20`, free text, dimension lines | ignored in Phase 1 (documented limitation) |

### 8.2 Synthetic fixtures

`scripts/generate_fixtures.py` draws each fixture with PyMuPDF: a simple part outline, a hole, a title block, and annotation lines at **known insertion points**. For each fixture it writes `drawings/<name>.pdf` and `expected/<name>.json`.

**Ground truth is hand-written in the fixture spec, never computed by our own code** — otherwise the tests would just check the code against itself. Generated PDFs are committed so reviewers can open them.

The test ruleset starts with the same thresholds as the demo ruleset: thickness ≥ 3 mm, diameter ≤ 50 mm, length 10–500 mm, material required.

| Fixture | Contents | Expected outcome (test ruleset) |
|---|---|---|
| `valid_basic` | 4 mm, Ø 20 mm, L 120 mm, SS400 | all `pass` |
| `violations` | 2 mm, Ø 65 mm, L 600 mm, SS400 | 3 × `fail`, material `pass` |
| `missing_material` | valid dims, no material | `MAT-REQ` → `missing` |
| `boundary_values` | thickness 3 mm, Ø 50 mm, Ø 50.01 mm, L 10 mm, L 500 mm, SS400 | `=min`/`=max` → `pass`; 50.01 → `fail` |
| `unit_conversion` | 0.3 cm, 2 in, 0.12 m, SS400 | 3 mm `pass` (exact), 50.8 mm `fail`, 120 mm `pass` |
| `ambiguous` | the ambiguous rows from §8.1 + `HARDNESS` | only `needs_review` / `missing`, **zero `fail`** |
| `no_annotations` | title block only | every rule `missing` |

Invalid inputs are built inside tests (not committed): non-PDF bytes, a truncated PDF, an encrypted PDF, a 2-page PDF, an image-only page (no text layer), an empty file, and an oversized body (via a tiny test limit).

Tests use `tests/fixtures/rules/test_rules.toml`, so tuning the demo thresholds never breaks tests.

### 8.3 Test layers

| Layer | What is asserted |
|---|---|
| unit | Decimal conversions are exact; every grammar row; schema invariants reject invalid states; rule config rejects every invalid case; engine covers every semantics row, including boundaries; **no `fail` from `ambiguous` input** |
| integration | per fixture: extracted measurements match ground truth field by field (type, value, unit, normalized value, status); each bbox contains its known insertion point and lies within the page; full-pipeline findings match the hand-written expectations |
| api | 200 responses validate against `InspectionReport`; each error code and status; error bodies leak no paths or tracebacks; concurrent requests all return correct reports |

Tooling: `pytest`, `httpx` (for `TestClient`), `ruff` (lint and format), `mypy --strict` on `src/`. CI runs all four on every push.

---

## 9. Milestones and acceptance criteria

Work happens on branch `feat/phase1-backend-mvp`: one commit per milestone after your approval, then one PR into `main` at the end.

| # | Milestone | Done when (all verified by running commands, results reported verbatim) |
|---|---|---|
| **M0** | Backend scaffold + CI | `uv sync` works from a clean clone; `pytest` (smoke test), `ruff check`, `ruff format --check`, `mypy --strict src` all pass locally; the GitHub Actions run is green |
| **M1** | Domain schemas + units | conversions exact for mm/cm/m/in (e.g. `0.1 in == 2.54 mm` with `Decimal`); validators reject a `parsed` measurement with missing fields; the report JSON round-trips |
| **M2** | Annotation parser | every row in §8.1 has a passing test, plus case and whitespace variants; the parser never raises on arbitrary input lines |
| **M3** | Ingestion + extraction + fixtures | 7 fixtures generated; extraction matches ground truth on all of them; bbox checks pass; each invalid-input case raises its specific typed error |
| **M4** | Rule config + engine | every semantics row and config-validation case tested; all 7 fixtures' end-to-end findings match expectations; the "no fail from ambiguous" invariant is tested |
| **M5** | API | the 3 endpoints work; every error code in §6 is tested; no leakage in error bodies; PDF work runs on the single worker; concurrency test passes |
| **M6** | Review + docs | PR Review Toolkit pass with findings fixed or explicitly deferred; README updated with real setup/test commands and only results that actually ran; PR merged after your approval |

---

## 10. The exact first coding task (M0)

1. Install `uv` (`winget install astral-sh.uv`) — it is not currently installed.
2. Create branch `feat/phase1-backend-mvp`.
3. Create `backend/pyproject.toml`:
   - runtime dependencies: `fastapi`, `pydantic`, `pydantic-settings`, `pymupdf`, `python-multipart`, `uvicorn`
   - dev dependencies: `pytest`, `httpx`, `ruff`, `mypy`
   - `requires-python >= 3.12` (developing on the installed 3.13.5)
   - ruff, mypy, and pytest configuration
   - versions checked against current releases at that time, with `uv.lock` committed
4. Create `backend/src/blueprintiq/__init__.py` (`__version__`) and `backend/tests/test_smoke.py`, which asserts the package and PyMuPDF import.
5. Create `.github/workflows/backend-ci.yml` (Ubuntu, Python 3.13, `uv sync --locked`, then ruff, mypy, and pytest).
6. Run all four checks locally, report the real output, push the branch, and confirm the CI run result.

M1 then starts with test-driven development (TDD). The first failing test is `test_inch_to_mm_is_exact`, followed by the minimal implementation in `domain/units.py`.

---

## 11. Risks, limitations, and open decisions

- **PyMuPDF licensing (decide before publishing).** PyMuPDF is AGPL-3.0, with a commercial license available. If BlueprintIQ goes public, licensing the repo under AGPL-3.0 is the simplest compliant option. The alternative is swapping the extractor for `pypdfium2` (Apache/BSD) or `pdfplumber` (MIT). Confining PyMuPDF to two modules keeps that swap cheap. This does not block private development.
- **Synthetic-to-real gap.** Fixtures generated with PyMuPDF place each annotation on one clean text line. Real CAD exports may split `THICKNESS:` and `4 mm` into separate spans or blocks, or use custom fonts. Phase 1 handles only same-line annotations; this is documented, not hidden. Perfect scores on synthetic fixtures **do not** demonstrate real-world accuracy, and no README text will claim otherwise.
- **Throughput.** PDF work is serialized (D5) and there is no hard timeout until the process-pool upgrade.
- **Out of scope:** scans/OCR, multi-page documents, `Ø`/symbol notation, tolerances, component association, Japanese labels, persistence, Docker, frontend, VLM, benchmarks.

---

## 12. Approved amendments (owner review, 2026-10-12)

These supersede anything above that conflicts with them.

**A. Approved assumptions.** Rules apply per measurement type; units mm/cm/m/in; English labels only; one TOML rules file loaded at startup; no database. Numeric dimensions and textual material annotations stay separate types (`DimensionMeasurement` vs `MaterialAnnotation`).

**B. Duplicate and conflicting annotations policy.**

Each dimension type has a fixed *cardinality* defined in code (`domain/models.py`), not in the rules file:

| Type | Cardinality | Rationale |
|---|---|---|
| `thickness` | single-valued | a plate part has one thickness |
| `material` | single-valued | one material per part |
| `diameter` | multi-valued | several holes are legitimate |
| `length` | multi-valued | several lengths may be annotated; Phase 1 cannot tell which is "overall" |

Evaluation of a **single-valued** type (all measurements of that type on the page are considered together):

| Situation | Outcome |
|---|---|
| All parsed values are equal (exact `Decimal` equality after normalization) | Treated as harmless duplicates. **One** finding referencing all duplicate measurement ids (`measurement_ids` has several entries). |
| Parsed values differ | **Conflict.** One `needs_review` finding listing all conflicting measurement ids. No `pass` or `fail`. |
| At least one parsed plus at least one ambiguous | One `needs_review` finding. The ambiguous annotation could contradict the parsed one, so no confirmed outcome is issued. |
| Only ambiguous | `needs_review` (as in §7). |

For **multi-valued** types each measurement is evaluated independently (§7), and each keeps its own evidence. Material comparison is exact on the normalized (trimmed, upper-case) string.

Required tests: duplicates with equal values, conflicting thickness (4 mm vs 6 mm: `needs_review`, never `fail`), thickness conflict where one value would violate the minimum, parsed + ambiguous thickness, multi-hole diameters evaluated separately, conflicting material.

**C. Decimal handling.** Rules are read with `tomllib.loads(text, parse_float=Decimal)`, so `min_mm = 3.0` is `Decimal("3.0")` and never passes through binary float. All unit conversion, comparison and threshold arithmetic uses `Decimal`. TOML integers are also converted to `Decimal`. Invalid rules produce an error naming the rule id, the field, and the reason.

**D. Concurrency.** Unchanged from D5: all PyMuPDF calls run on a single dedicated worker thread; a process pool is the documented upgrade.

**E. Upload and resource limits.** `MAX_UPLOAD_BYTES` = 10 MiB; `MAX_PAGES` = 1; the page count is checked before any text extraction; extraction stops with a typed error above `MAX_TEXT_LINES` (default 5000), so a pathological text-heavy PDF cannot create an unbounded report; PDFs are opened from memory and no temp files are written.

**F. Outcome visibility.** The report summary always reports the four counts (`passed`, `failed`, `missing`, `needs_review`) separately; nothing is merged into a single "issues" number.

**G. PDF engine.** Keep PyMuPDF for now behind an engine-neutral `TextLine` contract; revisit before publishing. See [ADR-001](adr-001-pdf-engine.md).

**H. Scope of this authorization.** Only M0 (project setup and CI) is authorized. M1–M6 need separate approval.
