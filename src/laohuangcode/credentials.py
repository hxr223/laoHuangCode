"""Private local storage for model provider credentials."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
from typing import Any

from .providers import get_provider


class CredentialStore:
    """Persist API keys separately from ordinary model configuration."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def get(self, provider: str) -> str | None:
        document = self._read()
        entry = document.get("providers", {}).get(provider)
        if entry is None:
            return None
        return entry["api_key"]

    def set(self, provider: str, api_key: str) -> None:
        get_provider(provider)
        api_key = api_key.strip()
        if not api_key:
            raise ValueError("API key cannot be empty")
        document = self._read()
        document.setdefault("version", 1)
        providers = document.setdefault("providers", {})
        providers[provider] = {"api_key": api_key}
        self._write(document)

    def remove(self, provider: str) -> bool:
        document = self._read()
        providers = document.get("providers", {})
        if provider not in providers:
            return False
        del providers[provider]
        self._write(document)
        return True

    def providers(self) -> tuple[str, ...]:
        document = self._read()
        return tuple(sorted(document.get("providers", {})))

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            document = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"Cannot read credentials: {error}") from error
        if not isinstance(document, dict):
            raise ValueError("Credentials root must be a JSON object")
        providers = document.get("providers", {})
        if not isinstance(providers, dict):
            raise ValueError("Credentials providers must be an object")
        for provider, entry in providers.items():
            if not isinstance(provider, str) or not isinstance(entry, dict):
                raise ValueError("Credentials contain an invalid provider entry")
            api_key = entry.get("api_key")
            if not isinstance(api_key, str) or not api_key:
                raise ValueError(f"Credential for '{provider}' has no API key")
        return document

    def _write(self, document: dict[str, Any]) -> None:
        parent_existed = self.path.parent.exists()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if not parent_existed:
            self.path.parent.chmod(0o700)
        content = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=self.path.parent,
            delete=False,
        ) as handle:
            handle.write(content)
            temporary_path = Path(handle.name)
        temporary_path.chmod(0o600)
        temporary_path.replace(self.path)
