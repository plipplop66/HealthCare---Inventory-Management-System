"""Runtime settings for the intelligence service, read from environment variables.

Variable names mirror backend/src/config.js so one set of values configures both services.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date

FIXTURE = "fixture"
MYSQL = "mysql"
DATA_SOURCES = (FIXTURE, MYSQL)
# Same default as backend/src/config.js: keeps the deterministic database seed on its simulation date.
DEFAULT_SIMULATION_DATE = date(2026, 9, 11)


@dataclass(frozen=True)
class Settings:
    data_source: str = FIXTURE
    database_host: str = "127.0.0.1"
    database_port: int = 3306
    database_name: str = "medripple"
    database_user: str = "medripple"
    database_password: str = ""
    simulation_date: date = DEFAULT_SIMULATION_DATE
    database_connect_timeout_seconds: int = 5


def load_settings(environ: Mapping[str, str] | None = None) -> Settings:
    """Read settings from the environment. Invalid values raise ValueError so startup fails loudly."""
    env = os.environ if environ is None else environ
    data_source = _text(env, "DATA_SOURCE", FIXTURE).lower()
    if data_source not in DATA_SOURCES:
        raise ValueError(f"DATA_SOURCE must be one of {', '.join(DATA_SOURCES)}; got {data_source!r}.")
    if data_source == MYSQL and _text(env, "DATABASE_URL", ""):
        raise ValueError(
            "DATABASE_URL is not supported by the intelligence service; set DATABASE_HOST, DATABASE_PORT, "
            "DATABASE_NAME, DATABASE_USER and DATABASE_PASSWORD instead."
        )
    raw_date = _text(env, "SIMULATION_DATE", DEFAULT_SIMULATION_DATE.isoformat())
    try:
        simulation_date = date.fromisoformat(raw_date)
    except ValueError as error:
        raise ValueError(f"SIMULATION_DATE must be a YYYY-MM-DD date; got {raw_date!r}.") from error
    return Settings(
        data_source=data_source,
        database_host=_text(env, "DATABASE_HOST", "127.0.0.1"),
        database_port=_integer(env, "DATABASE_PORT", 3306),
        database_name=_text(env, "DATABASE_NAME", "medripple"),
        database_user=_text(env, "DATABASE_USER", "medripple"),
        database_password=env.get("DATABASE_PASSWORD") or "",
        simulation_date=simulation_date,
        database_connect_timeout_seconds=_integer(env, "DATABASE_CONNECT_TIMEOUT_SECONDS", 5),
    )


def _text(env: Mapping[str, str], name: str, default: str) -> str:
    return (env.get(name) or "").strip() or default


def _integer(env: Mapping[str, str], name: str, default: int) -> int:
    raw = _text(env, name, "")
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer; got {raw!r}.") from error
