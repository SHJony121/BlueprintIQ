"""Production settings, and work that nobody is waiting for any more is stopped."""

import json
import sys
import threading
import time
from typing import Any

import anyio
import pytest
from pydantic import ValidationError

from blueprintiq.api.app import create_app
from blueprintiq.api.settings import Settings
from blueprintiq.api.worker import run_job
from tests.api import jobs
from tests.api.test_api import RULES, client
from tests.integration.fixture_data import pdf_bytes

# ------------------------------------------------------------- documentation switched off


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_the_interactive_documentation_is_off_in_production(path: str) -> None:
    response = client(environment="production").get(path)
    assert response.status_code == 404
    assert "openapi" not in response.text.lower()


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_the_documentation_stays_in_development(path: str) -> None:
    assert client().get(path).status_code == 200


def test_the_schema_can_still_be_exported_in_production() -> None:
    app = create_app(Settings(ruleset_path=RULES, environment="production"))
    assert "/api/v1/inspections" in app.openapi()["paths"]


def test_production_changes_nothing_else_about_inspection() -> None:
    api = client(environment="production")
    response = api.post(
        "/api/v1/inspections",
        content=pdf_bytes("valid_basic"),
        headers={"Content-Type": "application/pdf"},
    )
    assert response.status_code == 200 and response.json()["schema_version"] == "1.0"
    assert api.get("/healthz").json() == {"status": "ok"}


def test_an_unknown_environment_is_refused_at_startup() -> None:
    with pytest.raises(ValueError):
        Settings(ruleset_path=RULES, environment="staging")  # type: ignore[arg-type]


# ----------------------------------------------------- cancelling work nobody awaits


def test_a_cancelled_job_is_killed_at_once_and_has_exited() -> None:
    cancel = threading.Event()
    threading.Timer(1.0, cancel.set).start()
    started = time.perf_counter()
    result = run_job(jobs.sleep_forever, (60,), timeout_s=60, memory_limit_mb=None, cancel=cancel)
    assert result.kind == "cancelled"
    assert result.exitcode is not None and result.exitcode != 0  # the process ended (killed)
    assert time.perf_counter() - started < 15


def test_a_job_that_finishes_is_not_affected_by_an_unset_cancel_flag() -> None:
    result = run_job(jobs.echo, (1,), timeout_s=30, memory_limit_mb=None, cancel=threading.Event())
    assert (result.kind, result.value) == ("ok", 1)


def test_the_timeout_still_applies_with_a_cancel_flag() -> None:
    result = run_job(
        jobs.sleep_forever, (60,), timeout_s=2, memory_limit_mb=None, cancel=threading.Event()
    )
    assert result.kind == "timeout"


def test_a_client_that_disconnects_while_its_inspection_runs_frees_the_worker() -> None:
    """Drive the ASGI app by hand: send the body, then a disconnect, and time the answer."""
    app = create_app(Settings(ruleset_path=RULES), job=jobs.slow_inspection)  # a 60 s job
    body = pdf_bytes("valid_basic")
    sent: list[dict[str, Any]] = []
    messages = [{"type": "http.request", "body": body, "more_body": False}]

    async def receive() -> dict[str, Any]:
        if messages:
            return messages.pop(0)
        # Like a real server once the body is in: the call waits until the client goes.
        await anyio.sleep(1.0)
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "path": "/api/v1/inspections",
        "raw_path": b"/api/v1/inspections",
        "query_string": b"",
        "headers": [(b"content-type", b"application/pdf"), (b"host", b"test")],
        "client": ("127.0.0.1", 1),
        "server": ("test", 80),
        "scheme": "http",
    }

    async def drive() -> float:
        started = time.perf_counter()
        await app(scope, receive, send)
        return time.perf_counter() - started

    elapsed = anyio.run(drive)
    assert elapsed < 20  # not the job's 60 s
    start = next(m for m in sent if m["type"] == "http.response.start")
    assert start["status"] == 400
    payload = json.loads(
        b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    )
    assert payload["error"]["code"] == "CLIENT_DISCONNECTED"


# ------------------------------------------------------------------ worker start method


def test_worker_start_method_is_a_validated_setting() -> None:
    assert Settings().worker_start_method == "spawn"
    assert Settings(worker_start_method="forkserver").worker_start_method == "forkserver"
    with pytest.raises(ValidationError):
        Settings(worker_start_method="fork")  # type: ignore[arg-type]


@pytest.mark.skipif(sys.platform == "win32", reason="no fork server on Windows")
def test_an_inspection_runs_through_the_fork_server_in_its_own_process() -> None:
    from blueprintiq.api.worker import use_start_method

    try:
        api = client(worker_start_method="forkserver")
        response = api.post(
            "/api/v1/inspections",
            content=pdf_bytes("valid_basic"),
            headers={"Content-Type": "application/pdf"},
        )
        assert response.status_code == 200
        assert sum(response.json()["summary"].values()) > 0
    finally:
        use_start_method("spawn")


def test_the_fork_server_falls_back_to_spawn_where_it_does_not_exist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import multiprocessing

    from blueprintiq.api.worker import use_start_method

    monkeypatch.setattr(multiprocessing, "get_all_start_methods", lambda: ["spawn"])
    assert use_start_method("forkserver") == "spawn"
