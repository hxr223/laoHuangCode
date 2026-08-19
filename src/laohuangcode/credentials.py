"""Resolve model credentials without persisting secrets to config files."""

from __future__ import annotations

from collections.abc import Mapping

from .providers import Provider


def resolve_api_key(provider: Provider, environ: Mapping[str, str]) -> str:
    api_key = environ.get(provider.api_key_env)
    if not api_key:
        raise ValueError(
            f"Missing API key environment variable: {provider.api_key_env}"
        )
    return api_key
