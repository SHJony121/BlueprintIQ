# ADR-001 — PDF text engine: PyMuPDF vs pypdfium2

| | |
|---|---|
| **Status** | **Decided: keep PyMuPDF and release the project under AGPL-3.0-or-later** (owner decision; see [NOTICE.md](../../NOTICE.md)) |
| **Date** | 2026-10-12 |
| **Decision needed by** | Before the repository is made public (not before M1–M5) |

## Context

BlueprintIQ needs, from each PDF page: the text lines, the exact bounding box of each line, and the page dimensions. The bounding boxes are the evidence that later highlights the source annotation in the viewer. We also want the option to publish the repository under a licence of our choosing.

## Comparison

| Criterion | PyMuPDF | pypdfium2 (PDFium) |
|---|---|---|
| Licence | **AGPL-3.0** (or paid commercial licence). A public repo using it is simplest under AGPL-3.0; anyone deploying a modified network service must offer source. | **Apache-2.0 / BSD-3-Clause** (PDFium is BSD/Apache). No copyleft obligations. |
| Line / word / span grouping with bboxes | Built in: `get_text("dict")` / `"words"` return lines and spans with bboxes. | Not built in. Gives characters (`get_charbox`), text ranges (`get_text_range`) and merged text rectangles (`count_rects` / `get_rect`). Line grouping must be written and tested by us. |
| Coordinate system | Top-left origin, y down, points. Matches image/screen conventions. | PDF canvas units: bottom-left origin, y up. The same system PDF.js uses, so the later frontend mapping is simpler, but our stored convention would change. |
| Rotation / crop box | Text coordinates refer to the unrotated page; documented matrices convert (verified in docs). | Handled by PDFium page APIs; we would need to verify and test the equivalent behaviour ourselves. |
| Encrypted / corrupt PDFs | Detectable (`needs_pass`, open errors). | Raises `PdfiumError` with a PDFium error code; password supported. |
| Implementation complexity | Low: ~40 lines for line extraction. | Medium: ~100–150 lines plus tests for our own line grouping, where bugs would directly affect evidence boxes. |
| Concurrency | Documented as **not multithread-safe**; use processes. | PDFium is also not designed for concurrent use of a document across threads, so the same single-worker design applies. |
| Ecosystem / maturity | Very large user base, extensive docs. | Solid, smaller user base. |

Both engines can do everything Phase 1 needs. The difference is **licence versus implementation cost**.

## Recommendation

1. **Use PyMuPDF for Phases 1–2 (private development).** It is the lowest-risk way to get correct line bounding boxes, which are the core of our evidence-traceability goal. A bug in hand-written line grouping would silently corrupt evidence boxes, and in this project correctness outranks licence convenience *while the repo is private*.
2. **Keep the swap cheap.** PyMuPDF stays confined to `ingestion/` and `extraction/text_layer.py`. Layer B exposes a small engine-neutral result (`TextLine`: text, bbox in our stored convention, page number) so a second adapter can implement the same function.
3. **Decide before going public**, choosing one of:
   - **Publish under AGPL-3.0** with PyMuPDF (simplest, fully compliant, but copyleft; some employers dislike AGPL on portfolios).
   - **Write a `pypdfium2` adapter** (about one milestone: line grouping, coordinate conversion into our top-left convention, and re-running every fixture test against it). Both adapters would run against the same fixtures, which is also a strong correctness cross-check.
4. **Do not switch now.** Switching today would cost M3 time and add risk without any present benefit, because the repository is private.

## Consequences

- Phase 1 behaviour and the API are unaffected by the later decision, because the stored coordinate convention and `TextLine` contract are engine-neutral.
- The fixture generator script uses PyMuPDF to draw PDFs. It is a development tool, not part of the installed package, and the committed PDFs are plain data. If the licence decision requires it, `reportlab` or a hand-written PDF writer can replace it.
- Not yet verified: line-box parity between the two engines. That would be measured in the adapter milestone, not assumed.
