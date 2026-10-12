"""Committed fixture PDFs and ground truth must equal what the generator produces."""

import importlib.util
from pathlib import Path

GENERATOR = Path(__file__).resolve().parents[1] / "scripts" / "generate_fixtures.py"


def test_committed_fixtures_match_the_generator_byte_for_byte() -> None:
    spec = importlib.util.spec_from_file_location("generate_fixtures", GENERATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rendered: dict[Path, bytes] = module.render()
    assert len(rendered) == 64
    stale = [p.name for p, data in rendered.items() if not p.exists() or p.read_bytes() != data]
    assert stale == [], f"run scripts/generate_fixtures.py; stale: {stale}"
