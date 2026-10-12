"""Write the API's OpenAPI document to ``backend/openapi.json``.

Usage (from backend/):  uv run python scripts/export_openapi.py

The frontend generates its TypeScript API types from this committed snapshot
(``npm run api:types`` in frontend/), so the types are reproducible without
starting the backend. A test checks that the snapshot matches what the app
serves, so a schema change cannot be committed without updating it.
"""

import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND / "src"))

from blueprintiq.api.app import create_app  # noqa: E402

SNAPSHOT = BACKEND / "openapi.json"


def render() -> str:
    """The OpenAPI document as stable JSON text (sorted keys, LF line endings)."""
    return json.dumps(create_app().openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> None:
    # newline="" keeps the LF endings on Windows, so the file is identical everywhere.
    with SNAPSHOT.open("w", encoding="utf-8", newline="") as file:
        file.write(render())
    print(f"wrote {SNAPSHOT.relative_to(BACKEND)}")


if __name__ == "__main__":
    main()
