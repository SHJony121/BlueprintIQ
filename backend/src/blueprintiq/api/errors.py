"""One error envelope for every non-2xx response.

``{"error": {"code": "...", "message": "...", "request_id": "..."}}``

Messages are fixed, user-safe strings or the user-safe ``message`` of a
``DocumentRejectedError``. Exception text, paths and stack traces go to the server
log (tagged with the request id), never to the client.
"""

from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

# HTTP status for each rejection code raised by ingestion/extraction (M3).
REJECTION_STATUS = {
    "EMPTY_FILE": 422,
    "FILE_TOO_LARGE": 413,
    "UNSUPPORTED_FILE_TYPE": 415,
    "INVALID_PDF": 422,
    "ENCRYPTED_PDF": 422,
    "TOO_MANY_PAGES": 422,
    "NO_TEXT_LAYER": 422,
    "TOO_MANY_TEXT_LINES": 422,
    "UNSUPPORTED_GEOMETRY": 422,
    "PARTIALLY_VISIBLE_TEXT": 422,
    "PAGE_TOO_COMPLEX": 422,
}


class ErrorBody(BaseModel):
    code: str
    message: str
    request_id: str


class ErrorResponse(BaseModel):
    error: ErrorBody


class ApiError(Exception):
    """An error that maps directly to a response."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code
        self.message = message


def error_response(request: Request, status: int, code: str, message: str) -> JSONResponse:
    request_id = getattr(request.state, "request_id", "")
    body = ErrorResponse(error=ErrorBody(code=code, message=message, request_id=request_id))
    return JSONResponse(status_code=status, content=body.model_dump(), headers=_headers(request))


def _headers(request: Request) -> dict[str, Any]:
    request_id = getattr(request.state, "request_id", None)
    return {"X-Request-ID": request_id} if request_id else {}
