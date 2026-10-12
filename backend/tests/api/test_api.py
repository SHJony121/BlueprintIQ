"""HTTP API: contract, upload safety, errors, isolation and concurrency."""

import io
import json
import logging
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import anyio
import pytest
from fastapi.testclient import TestClient

from blueprintiq.api.app import create_app
from blueprintiq.api.logging_setup import JsonFormatter
from blueprintiq.api.settings import Settings
from blueprintiq.api.worker import memory_limit_supported
from blueprintiq.domain.models import InspectionReport
from blueprintiq.rules.config import RulesetConfigError
from tests.api import jobs
from tests.fixtures.expected_findings import EXPECTED_FINDINGS
from tests.integration.fixture_data import pdf_bytes

RULES = Path(__file__).resolve().parents[1] / "fixtures" / "rules" / "test_rules.toml"
URL = "/api/v1/inspections"
PDF = {"Content-Type": "application/pdf"}


def client(**overrides: Any) -> TestClient:
    job = overrides.pop("job", None)
    settings = Settings(ruleset_path=RULES, **overrides)
    app = create_app(settings) if job is None else create_app(settings, job=job)
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture(scope="module")
def api() -> TestClient:
    return client()


def post(api: TestClient, data: bytes, **kwargs: Any) -> Any:
    headers = kwargs.pop("headers", PDF)
    return api.post(URL, content=data, headers=headers, **kwargs)


def assert_error(response: Any, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body = response.json()
    assert set(body) == {"error"}
    assert body["error"]["code"] == code
    assert body["error"]["request_id"] == response.headers["x-request-id"]
    text = response.text
    for leak in ("Traceback", "C:\\\\", "/home/", "site-packages", "secret", "mupdf", 'File "'):
        assert leak not in text, f"{leak!r} leaked: {text}"
    return dict(body["error"])


# ------------------------------------------------------------------ success


def test_health_reveals_nothing_about_configuration(api: TestClient) -> None:
    response = api.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.parametrize("name", ["valid_basic", "violations", "ambiguous", "conflicting",
                                  "missing_material", "rotated_90", "wide_gaps"])  # fmt: skip
def test_inspection_returns_the_expected_findings(api: TestClient, name: str) -> None:
    response = post(api, pdf_bytes(name), headers=PDF | {"X-Filename": f"{name}.pdf"})
    assert response.status_code == 200, response.text
    report = InspectionReport.model_validate_json(response.text)
    got = tuple((f.rule_id, f.status.value, f.measurement_ids) for f in report.findings)
    assert got == EXPECTED_FINDINGS[name]
    assert report.document.filename == f"{name}.pdf"
    assert response.headers["x-request-id"]


def test_findings_carry_evidence_matching_the_measurements(api: TestClient) -> None:
    report = InspectionReport.model_validate_json(post(api, pdf_bytes("violations")).text)
    by_id = {m.id: m for m in report.measurements}
    for f in report.findings:
        for ref in f.evidence:
            assert ref.bbox == by_id[ref.measurement_id].source.bbox
            assert ref.bbox is not None


def test_missing_and_ambiguous_are_distinct_outcomes(api: TestClient) -> None:
    missing = InspectionReport.model_validate_json(post(api, pdf_bytes("missing_material")).text)
    ambiguous = InspectionReport.model_validate_json(post(api, pdf_bytes("ambiguous")).text)
    assert missing.summary.missing == 1 and missing.summary.needs_review == 0
    assert ambiguous.summary.needs_review == 4 and ambiguous.summary.failed == 0


def test_content_type_parameters_are_accepted(api: TestClient) -> None:
    headers = {"Content-Type": "Application/PDF; charset=binary"}
    assert post(api, pdf_bytes("valid_basic"), headers=headers).status_code == 200


def test_openapi_documents_the_pdf_body_and_errors(api: TestClient) -> None:
    spec = api.get("/openapi.json").json()
    operation = spec["paths"][URL]["post"]
    assert "application/pdf" in operation["requestBody"]["content"]
    assert {"200", "413", "415", "422", "500", "503"} <= set(operation["responses"])


# ------------------------------------------------------------ upload safety


@pytest.mark.parametrize(
    "headers",
    [{}, {"Content-Type": "multipart/form-data; boundary=x"}, {"Content-Type": "application/json"},
     {"Content-Type": "application/octet-stream"}, {"Content-Type": "text/plain"}],
)  # fmt: skip
def test_wrong_content_type_is_refused(api: TestClient, headers: dict[str, str]) -> None:
    assert_error(
        post(api, pdf_bytes("valid_basic"), headers=headers), 415, "UNSUPPORTED_CONTENT_TYPE"
    )


def test_pdf_content_type_with_non_pdf_bytes_is_refused(api: TestClient) -> None:
    assert_error(post(api, b"just text"), 415, "UNSUPPORTED_FILE_TYPE")


def test_png_renamed_to_pdf_is_refused(api: TestClient) -> None:
    png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
    assert_error(
        post(api, png, headers=PDF | {"X-Filename": "drawing.pdf"}), 415, "UNSUPPORTED_FILE_TYPE"
    )


def test_empty_body_is_refused(api: TestClient) -> None:
    assert_error(post(api, b""), 422, "EMPTY_FILE")


def test_oversized_upload_is_refused(api: TestClient) -> None:
    assert_error(post(api, b"%PDF-" + b"0" * (10 * 1024 * 1024)), 413, "FILE_TOO_LARGE")


def test_upload_exactly_at_a_small_limit_is_processed_and_one_byte_more_is_not() -> None:
    data = pdf_bytes("valid_basic")
    assert post(client(max_upload_bytes=len(data)), data).status_code == 200
    assert_error(post(client(max_upload_bytes=len(data) - 1), data), 413, "FILE_TOO_LARGE")


def test_size_limit_is_enforced_on_the_stream_without_content_length() -> None:
    received: list[int] = []

    def chunks() -> Iterator[bytes]:
        yield b"%PDF-"
        for _ in range(64):  # 64 MiB offered; the server must stop long before
            received.append(1)
            yield b"0" * (1024 * 1024)

    small = client(max_upload_bytes=2 * 1024 * 1024)
    response = small.post(URL, content=chunks(), headers=PDF)  # chunked: no Content-Length
    assert_error(response, 413, "FILE_TOO_LARGE")


def test_overlong_filename_parameter_is_refused(api: TestClient) -> None:
    response = post(api, pdf_bytes("valid_basic"), headers=PDF | {"X-Filename": "x" * 300})
    assert_error(response, 422, "REQUEST_VALIDATION_ERROR")


def test_path_in_filename_is_never_echoed(api: TestClient) -> None:
    response = post(
        api, pdf_bytes("valid_basic"), headers=PDF | {"X-Filename": "C:\\secret\\dir\\a.pdf"}
    )
    assert InspectionReport.model_validate_json(response.text).document.filename == "a.pdf"


@pytest.mark.parametrize(
    ("name", "status", "code"),
    [("multi_page", 422, "TOO_MANY_PAGES"), ("no_text", 422, "NO_TEXT_LAYER"),
     ("partially_visible", 422, "PARTIALLY_VISIBLE_TEXT"),
     ("rotate_135", 422, "UNSUPPORTED_GEOMETRY")],
)  # fmt: skip
def test_pdf_validation_codes_reach_the_client(
    api: TestClient, name: str, status: int, code: str
) -> None:
    assert_error(post(api, pdf_bytes(name)), status, code)


def test_truncated_pdf_is_invalid(api: TestClient) -> None:
    data = pdf_bytes("valid_basic")
    assert_error(post(api, data[: len(data) // 2]), 422, "INVALID_PDF")


# --------------------------------------------------------- routing errors


def test_unknown_path_and_method_use_the_envelope(api: TestClient) -> None:
    assert_error(api.get("/nope"), 404, "NOT_FOUND")
    assert_error(api.get(URL), 405, "METHOD_NOT_ALLOWED")


def test_client_supplied_request_id_is_ignored(api: TestClient) -> None:
    response = api.get("/healthz", headers={"X-Request-ID": "injected\nvalue"})
    assert response.headers["x-request-id"] != "injected\nvalue"
    assert len(response.headers["x-request-id"]) == 32


# ------------------------------------------------- worker isolation via API


def test_slow_inspection_times_out_and_returns_a_typed_error() -> None:
    slow = client(job=jobs.slow_inspection, job_timeout_s=2)
    assert_error(post(slow, pdf_bytes("valid_basic")), 422, "PROCESSING_TIMEOUT")


def test_crashing_worker_returns_a_typed_error_and_the_server_keeps_working() -> None:
    crashing = client(job=jobs.crash_inspection)
    assert_error(post(crashing, pdf_bytes("valid_basic")), 422, "PROCESSING_FAILED")
    assert crashing.get("/healthz").status_code == 200


def test_unexpected_worker_error_is_logged_not_leaked(caplog: pytest.LogCaptureFixture) -> None:
    broken = client(job=jobs.broken_inspection)
    logger = logging.getLogger("blueprintiq")
    logger.addHandler(caplog.handler)
    try:
        error = assert_error(post(broken, pdf_bytes("valid_basic")), 500, "INTERNAL_ERROR")
    finally:
        logger.removeHandler(caplog.handler)
    assert error["message"] == "An unexpected error occurred."
    logged = [r for r in caplog.records if getattr(r, "event", None) == "inspection"]
    assert any("secret detail" in str(getattr(r, "detail", "")) for r in caplog.records)
    assert logged and all(getattr(r, "request_id", None) == error["request_id"] for r in logged)


@pytest.mark.skipif(not memory_limit_supported(), reason="no memory limit on Windows")
def test_memory_hungry_inspection_is_stopped() -> None:
    hog = client(job=jobs.memory_hog_inspection, job_memory_limit_mb=512)
    error = assert_error(post(hog, pdf_bytes("valid_basic")), 422, "RESOURCE_LIMIT_EXCEEDED")
    assert error["message"] == "The document needs more memory than allowed."


def test_busy_server_answers_503_instead_of_queueing_forever() -> None:
    busy = client(
        job=jobs.slow_inspection, job_timeout_s=5, max_concurrent_jobs=1, queue_timeout_s=0.5
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(post, busy, pdf_bytes("valid_basic"))
        second = pool.submit(post, busy, pdf_bytes("valid_basic"))
        codes = sorted(r.json()["error"]["code"] for r in (first.result(), second.result()))
    assert codes == ["PROCESSING_TIMEOUT", "SERVER_BUSY"]


def test_concurrent_requests_each_get_their_own_correct_report() -> None:
    api = client(max_admitted_requests=12)  # admit every request in this test
    names = ["valid_basic", "violations", "conflicting", "ambiguous"] * 3
    with ThreadPoolExecutor(max_workers=6) as pool:
        responses = list(pool.map(lambda n: post(api, pdf_bytes(n)), names))
    for name, response in zip(names, responses, strict=True):
        assert response.status_code == 200
        report = InspectionReport.model_validate_json(response.text)
        assert (
            tuple((f.rule_id, f.status.value, f.measurement_ids) for f in report.findings)
            == (EXPECTED_FINDINGS[name])
        )


# ------------------------------------------------------------ configuration


def test_invalid_ruleset_stops_startup(tmp_path: Path) -> None:
    bad = tmp_path / "rules.toml"
    bad.write_text('[ruleset]\nid = "x"\nversion = "1"\ndescription = "d"\n', encoding="utf-8")
    with pytest.raises(RulesetConfigError):
        create_app(Settings(ruleset_path=bad))


def test_missing_ruleset_file_stops_startup(tmp_path: Path) -> None:
    with pytest.raises(RulesetConfigError):
        create_app(Settings(ruleset_path=tmp_path / "absent.toml"))


def test_settings_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BLUEPRINTIQ_JOB_TIMEOUT_S", "12.5")
    monkeypatch.setenv("BLUEPRINTIQ_MAX_CONCURRENT_JOBS", "3")
    settings = Settings()
    assert (settings.job_timeout_s, settings.max_concurrent_jobs) == (12.5, 3)


@pytest.mark.parametrize(
    "field", [{"job_timeout_s": 0}, {"max_concurrent_jobs": 0}, {"max_upload_bytes": 0}]
)
def test_invalid_settings_are_rejected(field: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        Settings(**field)


def test_logs_are_json_without_drawing_text() -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger = logging.getLogger("blueprintiq")
    logger.addHandler(handler)
    try:
        post(client(), pdf_bytes("violations"), headers=PDF | {"X-Filename": "secret-name.pdf"})
    finally:
        logger.removeHandler(handler)
    output = stream.getvalue()
    lines = [json.loads(line) for line in output.splitlines()]
    inspection = [entry for entry in lines if entry.get("event") == "inspection"]
    assert inspection and inspection[0]["result"] == "ok" and inspection[0]["failed"] == 3
    assert len(inspection[0]["sha256_prefix"]) == 12
    assert "THICKNESS" not in output and "secret-name" not in output


# ------------------------------------------------- security review regressions


def test_non_ascii_filename_is_sent_percent_encoded(api: TestClient) -> None:
    response = post(
        api, pdf_bytes("valid_basic"), headers=PDF | {"X-Filename": "%E5%9B%B3%E9%9D%A2.pdf"}
    )
    assert (
        InspectionReport.model_validate_json(response.text).document.filename == "\u56f3\u9762.pdf"
    )


def test_filename_is_not_part_of_the_url() -> None:
    spec = client().get("/openapi.json").json()
    params = spec["paths"][URL]["post"].get("parameters", [])
    assert all(p["in"] != "query" for p in params)


def test_requests_beyond_the_admission_cap_are_refused_immediately() -> None:
    busy = client(
        job=jobs.slow_inspection, job_timeout_s=4, max_concurrent_jobs=1, max_admitted_requests=1
    )
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = [pool.submit(post, busy, pdf_bytes("valid_basic")) for _ in range(3)]
        codes = sorted(f.result().json()["error"]["code"] for f in futures)
    assert codes == ["PROCESSING_TIMEOUT", "SERVER_BUSY", "SERVER_BUSY"]


@pytest.mark.anyio
async def test_body_reading_stops_at_the_limit_without_consuming_the_rest() -> None:
    """Drive _read_body with a counting ASGI receive: it must stop right after the limit."""
    from starlette.requests import Request as StarletteRequest

    from blueprintiq.api.app import _read_body
    from blueprintiq.api.errors import ApiError

    chunk = b"0" * 65536
    calls = 0

    async def receive() -> dict[str, Any]:
        nonlocal calls
        calls += 1
        return {"type": "http.request", "body": chunk, "more_body": calls < 10_000}

    scope = {"type": "http", "method": "POST", "headers": [], "path": URL, "query_string": b""}
    request = StarletteRequest(scope, receive)
    limit = 1024 * 1024  # 16 chunks
    with pytest.raises(ApiError) as excinfo:
        await _read_body(request, limit)
    assert excinfo.value.code == "FILE_TOO_LARGE"
    assert calls == limit // len(chunk) + 1  # 17 of 10,000 offered chunks


@pytest.mark.anyio
async def test_slow_upload_is_cut_off_with_upload_timeout() -> None:
    import httpx

    from blueprintiq.api.settings import Settings as S

    app = create_app(S(ruleset_path=RULES, upload_timeout_s=1))

    async def trickle() -> Any:
        yield b"%PDF-"
        await anyio.sleep(5)
        yield b"never"

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        response = await http.post(URL, content=trickle(), headers=PDF)
    assert_error(response, 408, "UPLOAD_TIMEOUT")


def test_invalid_worker_report_is_a_generic_500_and_not_logged_verbatim() -> None:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(JsonFormatter())
    logger = logging.getLogger("blueprintiq")
    logger.addHandler(handler)
    try:
        error = assert_error(
            post(client(job=jobs.bad_report_inspection), pdf_bytes("valid_basic")),
            500,
            "INTERNAL_ERROR",
        )
    finally:
        logger.removeHandler(handler)
    assert error["message"] == "An unexpected error occurred."
    assert "DRAWING-SECRET" not in stream.getvalue()


def test_json_log_records_the_exception_type_only() -> None:
    record = logging.LogRecord("blueprintiq", logging.ERROR, __file__, 1, "x", None, None)
    try:
        raise ValueError("DRAWING-SECRET text")
    except ValueError:
        import sys

        record.exc_info = sys.exc_info()
    entry = json.loads(JsonFormatter().format(record))
    assert entry["exc_type"] == "ValueError"
    assert "DRAWING-SECRET" not in json.dumps(entry)
