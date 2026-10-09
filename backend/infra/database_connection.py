"""PostgreSQL/Supabase access layer: connection management and query caching.

Generic, domain-free plumbing - it knows how to connect to PostgreSQL/Supabase
and cache results, but nothing about players, stats, or projections (that is
handled by data_retrieval).

Public API:
  - query(view_name)            cached SELECT * FROM <view>
  - peek(view_name)             cached frame if present, else None
  - run_query(sql)              uncached arbitrary SQL
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

import pandas as pd
import sqlalchemy as sa
from sqlalchemy.engine import Engine

from backend.infra.secret_config import get_secret

logger = logging.getLogger('fbbo.database')

# -- Query cache ---------------------------------------------------------------

_cache: dict[str, tuple[float, pd.DataFrame]] = {}
_cache_lock = threading.Lock()
_CACHE_TTL = 24 * 3600  # 24 hours

# If set, Parquet files are read/written here before querying the database.
_DISK_CACHE_DIR: Path | None = (
    Path(os.environ['DISK_CACHE_DIR']) if 'DISK_CACHE_DIR' in os.environ else None
)


def query(view_name: str) -> pd.DataFrame:
    """Fetch a full view from the database with a 24-hour in-memory and disk cache."""
    cache_key = view_name.upper()
    with _cache_lock:
        entry = _cache.get(cache_key)
        if entry is not None and time.time() - entry[0] < _CACHE_TTL:
            return entry[1].copy()

    disk_path = _disk_cache_path(cache_key)
    if disk_path is not None and disk_path.exists():
        age = time.time() - disk_path.stat().st_mtime
        if age < _CACHE_TTL:
            df = pd.read_parquet(disk_path)
            with _cache_lock:
                _cache[cache_key] = (time.time() - age, df)
            return df.copy()

    qualified_name = view_name if '.' in view_name else f'fbbo.{view_name}'
    df = run_query(f'SELECT * FROM {qualified_name}')

    if disk_path is not None:
        disk_path.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(disk_path, index=False)

    with _cache_lock:
        _cache[cache_key] = (time.time(), df)

    return df.copy()


def _disk_cache_path(view_name: str) -> Path | None:
    if _DISK_CACHE_DIR is None:
        return None
    return _DISK_CACHE_DIR / f'{view_name}.parquet'


def peek(view_name: str) -> pd.DataFrame | None:
    """The cached frame for view_name if present and unexpired, else None - never loads.

    Callers (such as headshot-prefetch id listing) run in parallel with a session build
    fetching the same view, so triggering a load here would duplicate queries; callers
    only read, so the defensive copy made by query() is omitted.
    """
    cache_key = view_name.upper()
    with _cache_lock:
        entry = _cache.get(cache_key)
        if entry is not None and time.time() - entry[0] < _CACHE_TTL:
            return entry[1]
    return None


# -- Connection ----------------------------------------------------------------

_engine: Optional[Engine] = None
_engine_lock = threading.Lock()


def _get_engine() -> Engine:
    """Return the shared SQLAlchemy Engine instance, creating it if needed."""
    global _engine
    with _engine_lock:
        if _engine is None:
            db_url = get_secret('DATABASE_URL')
            if not db_url:
                raise RuntimeError(
                    'DATABASE_URL is not configured. '
                    'Please set DATABASE_URL in the environment or in .streamlit/secrets.toml.'
                )
            _engine = sa.create_engine(
                db_url,
                connect_args={'options': '-csearch_path=fbbo,public'},
                pool_pre_ping=True,
                pool_recycle=3600,
                pool_size=5,
                max_overflow=10,
            )
        return _engine


def run_query(sql: str) -> pd.DataFrame:
    """Execute arbitrary SQL on the shared connection and return the result (uncached).

    Normalizes DataFrame column names to uppercase so they match Snowflake/parameter
    conventions across the application.
    """
    engine = _get_engine()
    try:
        with engine.connect() as conn:
            conn.execute(sa.text('SET search_path TO fbbo, public'))
            df = pd.read_sql(sql, conn)
    except Exception as exc:
        logger.error('Database query failed for SQL: %s. Error: %s', sql, exc)
        raise

    # Normalize column names to uppercase to match parameters.yaml mappings
    df.columns = [str(c).upper() for c in df.columns]
    return df
