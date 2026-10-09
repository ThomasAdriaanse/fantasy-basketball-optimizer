"""Database access layer: backwards-compatibility shim for snowflake_connection.

Re-exports query, peek, run_query from backend.infra.database_connection.
"""

from __future__ import annotations

from backend.infra.database_connection import peek, query, run_query

__all__ = ['peek', 'query', 'run_query']
