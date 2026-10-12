# Architecture

Phase 1 is a stateless backend: one request in, one validated report out. The full design record and every decision's rationale are in [design/phase1-mvp-spec.md](design/phase1-mvp-spec.md); this page is the map.

## Layers

| Layer | Package | Depends on | Pure? |
|---|---|---|---|
| Domain | `domain/` (`models`, `units`, `geometry`) | — | yes |
| Ingestion | `ingestion/` (`pdf_loader`, `limits`, `errors`) | PyMuPDF | no |
| Text extraction | `extraction/text_layer.py`, `reader.py` | PyMuPDF, domain | no |
| Parser | `extraction/annotation_parser.py` | domain | **yes** |
| Rules | `rules/` (`config`, `engine`) | domain | **yes** |
| Pipeline | `inspection.py` | all of the above | no |
| API | `api/` | pipeline | no |

PyMuPDF is imported only by `ingestion/pdf_loader.py` and `extraction/text_layer.py` (and its call site in `reader.py`). The parser and the rules engine never see a PDF, so most correctness is tested on plain text and data. This also keeps the PDF engine replaceable (ADR-001).

## Data flow

1. **Upload (api).** The request body is the PDF, counted as it streams; refused past 10 MiB. The server admits a limited number of requests, then hands the bytes to a fresh worker process.
2. **Ingestion.** Checks, cheapest first: empty, size, `%PDF-` signature, parse, encryption, page count, damage/repair.
3. **Text layer.** Visible text lines with bounding boxes in **page space**; hidden text dropped and counted; partly visible text refuses the document; cost bounded before the expensive passes.
4. **Parser.** Lines → `DimensionMeasurement` / `MaterialAnnotation`, each `parsed` or `ambiguous` with an issue code and the raw source text and box.
5. **Rules.** `evaluate(measurements, ruleset)` → findings with `pass` / `fail` / `missing` / `needs_review`, evidence references and fixed-template explanations.
6. **Report.** `InspectionReport`, validated by cross-checks (ids unique, evidence matches source, summary matches findings, no confirmed outcome on an ambiguous measurement), returned as JSON.

## Key decisions

* **No AI in Phase 1.** CAD-exported PDFs already contain exact text and coordinates; reading them is exact, free and reproducible.
* **Decimal everywhere**, JSON numbers as strings; floats and JSON numbers are rejected on input.
* **Extraction status ≠ rule outcome.** `parsed`/`ambiguous` describes a read; `pass`/`fail`/`missing`/`needs_review` describes a rule result. The report validator enforces that uncertainty cannot become a verdict.
* **Single-valued types** (thickness, material) are judged together: identical readings are one value, a conflict or an unreadable annotation gives `needs_review`. **Multi-valued** types (diameter, length) are judged per annotation.
* **Coordinates:** stored in page space (unrotated visible area, origin top-left, points); `/Rotate` is metadata; `ViewerRect` is a separate type; `PageInfo.pdf_crop_box` carries the file's own box for future PDF.js overlays (spec §15.1).
* **Process isolation for untrusted PDFs:** a fresh `spawn` process per request with a deadline (and a memory limit on Linux), JSON-only results; PyMuPDF is not thread-safe, so work is also serialized inside the process (spec §15.5, §17.3).
* **Fail closed:** unknown MuPDF warnings, unknown geometry, and uncertain text refuse or flag rather than guess.

## Coordinate conventions

| Space | Used for |
|---|---|
| Page space (stored) | every `BBox` |
| Viewer space (`ViewerRect`, derived) | reading order, future on-screen overlays |
| PDF user space (`pdf_crop_box`) | mapping to PDF.js |

## Configuration

One TOML ruleset, parsed with `parse_float=Decimal`, validated in full at startup; an invalid file stops the server. Two rule kinds only: `range` (inclusive `min_mm` / `max_mm`) and `required`. See `backend/src/blueprintiq/rules/demo_rules.toml`.
