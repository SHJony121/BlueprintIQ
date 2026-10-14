"""API settings: explicit, typed, overridable with BLUEPRINTIQ_* environment variables."""

from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from blueprintiq.ingestion.limits import MIB

# Ships inside the package, so an installed wheel starts without configuration.
DEFAULT_RULESET = Path(__file__).resolve().parents[1] / "rules" / "demo_rules.toml"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="BLUEPRINTIQ_", frozen=True, extra="forbid")

    # "production" switches off the interactive API documentation (/docs, /redoc and
    # /openapi.json); nothing else about the API changes.
    environment: Literal["development", "production"] = "development"
    ruleset_path: Path = DEFAULT_RULESET
    max_upload_bytes: int = Field(default=10 * MIB, ge=1)
    job_timeout_s: float = Field(default=30.0, gt=0)  # wall clock per inspection
    job_memory_limit_mb: int = Field(default=1024, ge=64)  # Linux only; see api.worker
    max_concurrent_jobs: int = Field(default=2, ge=1)  # simultaneous worker processes
    queue_timeout_s: float = Field(default=30.0, gt=0)  # wait for a free worker, then 503
    # Requests admitted at once (uploading, waiting or running). Bounds memory held
    # by request bodies to about max_admitted_requests x max_upload_bytes.
    max_admitted_requests: int = Field(default=4, ge=1)
    upload_timeout_s: float = Field(default=30.0, gt=0)  # whole body must arrive in time
    log_level: str = "INFO"
