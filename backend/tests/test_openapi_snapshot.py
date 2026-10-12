"""The committed OpenAPI snapshot, which the frontend's types are generated from, is current."""

import importlib.util
import json
from pathlib import Path
from typing import Any

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "export_openapi.py"


def _exporter() -> Any:
    spec = importlib.util.spec_from_file_location("export_openapi", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_committed_openapi_matches_the_app() -> None:
    exporter = _exporter()
    committed = exporter.SNAPSHOT.read_bytes().decode("utf-8")
    assert committed == exporter.render(), (
        "backend/openapi.json is stale: run `uv run python scripts/export_openapi.py` "
        "in backend/, then `npm run api:types` in frontend/"
    )


def test_snapshot_describes_the_routes_the_frontend_uses() -> None:
    spec = json.loads(_exporter().SNAPSHOT.read_text(encoding="utf-8"))
    assert set(spec["paths"]) == {"/healthz", "/api/v1/inspections"}
    assert set(spec["paths"]["/api/v1/inspections"]) == {"post"}
