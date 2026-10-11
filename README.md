# BlueprintIQ

**Engineering drawing intelligence.** BlueprintIQ extracts annotated measurements from 2D engineering drawings (PDF), validates them against configurable inspection rules, and reports findings with evidence that traces back to the exact location on the source drawing.

> **Status:** Early development. There is no functional release yet. This README will be expanded as each milestone is implemented and verified.

## Goal

```
PDF drawing → extract measurements → validate structured data → evaluate rules → findings with evidence
```

Every finding should be explainable: which rule fired, which measurement it used, the raw source text, and where on the page that text was found. Uncertain or missing information is reported as such — never silently treated as a confirmed violation.

## Planned initial scope (Phase 1)

- Single-page, vector/text-based PDF drawings (no scanned images)
- A small set of explicitly labeled annotation formats, e.g. `THICKNESS: 4 mm`, `MATERIAL: SS400`
- Deterministic extraction and rule evaluation
- A FastAPI backend that returns structured inspection findings
- Synthetic test drawings with known ground truth

## Planned technology

- **Backend:** Python, FastAPI, Pydantic, PyMuPDF, pytest
- **Frontend (later phase):** Next.js, TypeScript, Tailwind CSS, PDF.js

## Disclaimer

BlueprintIQ is an **assistive engineering prototype**. It is not certified compliance software and does not guarantee engineering safety, regulatory compliance, or manufacturing correctness. Rule thresholds in this repository are demonstration values, not industry standards.

## License

Not yet licensed. All rights reserved until a license is selected.
