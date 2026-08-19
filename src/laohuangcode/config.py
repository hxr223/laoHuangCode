"""Persistent model profiles and runtime configuration."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import json
import os
from pathlib import Path
import tempfile
from typing import Any

from .credentials import CredentialStore
from .providers import get_provider


@dataclass(frozen=True)
class Config:
    model: str
    base_url: str | None = None
    provider: str = "openai-compatible"
    profile: str | None = None
    api_key: str | None = None


class ConfigManager:
    """Persist model profiles and resolve one into runtime configuration."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def configure(
        self,
        *,
        name: str,
        provider: str,
        model: str | None = None,
        base_url: str | None = None,
    ) -> None:
        preset = get_provider(provider)
        resolved_model = model or preset.default_model
        if not resolved_model:
            raise ValueError(f"A model is required for provider: {provider}")

        document = self._read_document(optional=True)
        document.setdefault("version", 1)
        profiles = document.setdefault("profiles", {})
        profiles[name] = {
            "provider": provider,
            "model": resolved_model,
            "base_url": base_url if base_url is not None else preset.base_url,
        }
        document["active_profile"] = name
        self._write_document(document)

    def resolve(
        self,
        *,
        credentials: CredentialStore,
        environ: Mapping[str, str] | None = None,
        profile: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
    ) -> Config:
        config = self.resolve_settings(
            environ=environ,
            profile=profile,
            model=model,
            base_url=base_url,
        )
        api_key = credentials.get(config.provider)
        if not api_key:
            raise ValueError(
                f"No API key configured for provider: {config.provider}"
            )
        return Config(
            api_key=api_key,
            model=config.model,
            base_url=config.base_url,
            provider=config.provider,
            profile=config.profile,
        )

    def resolve_settings(
        self,
        *,
        environ: Mapping[str, str] | None = None,
        profile: str | None = None,
        model: str | None = None,
        base_url: str | None = None,
    ) -> Config:
        document = self._read_document()
        environment = os.environ if environ is None else environ
        profile_name = (
            profile
            or environment.get("LAOHUANG_PROFILE")
            or document.get("active_profile")
        )
        profiles = document.get("profiles", {})
        if not profile_name or profile_name not in profiles:
            raise ValueError("No configured model profile")

        stored = profiles[profile_name]
        provider_name = stored["provider"]
        get_provider(provider_name)
        resolved_model = model or environment.get("LAOHUANG_MODEL") or stored["model"]
        resolved_base_url = (
            base_url
            if base_url is not None
            else environment.get("LAOHUANG_BASE_URL", stored.get("base_url"))
        )
        return Config(
            model=resolved_model,
            base_url=resolved_base_url,
            provider=provider_name,
            profile=profile_name,
        )

    def set_active(self, name: str) -> None:
        document = self._read_document()
        profiles = document.get("profiles", {})
        if name not in profiles:
            raise ValueError(f"Unknown profile: {name}")
        document["active_profile"] = name
        self._write_document(document)

    def list_profiles(self) -> tuple[dict[str, object], ...]:
        document = self._read_document()
        active = document.get("active_profile")
        profiles = document.get("profiles", {})
        return tuple(
            {
                "name": name,
                "active": name == active,
                **profile,
            }
            for name, profile in sorted(profiles.items())
        )

    def _read_document(self, *, optional: bool = False) -> dict[str, Any]:
        if not self.path.exists():
            if optional:
                return {}
            raise ValueError(f"Configuration file not found: {self.path}")
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise ValueError(f"Cannot read configuration: {error}") from error
        if not isinstance(value, dict):
            raise ValueError("Configuration root must be a JSON object")
        self._validate_document(value)
        return value

    @staticmethod
    def _validate_document(document: dict[str, Any]) -> None:
        version = document.get("version", 1)
        if version != 1:
            raise ValueError(f"Unsupported configuration version: {version}")

        active = document.get("active_profile")
        if active is not None and not isinstance(active, str):
            raise ValueError("Configuration active_profile must be a string")

        profiles = document.get("profiles", {})
        if not isinstance(profiles, dict):
            raise ValueError("Configuration profiles must be an object")
        for name, profile in profiles.items():
            if not isinstance(name, str) or not name:
                raise ValueError(
                    "Configuration profile names must be non-empty strings"
                )
            if not isinstance(profile, dict):
                raise ValueError(f"Configuration profile '{name}' must be an object")
            provider = profile.get("provider")
            model = profile.get("model")
            base_url = profile.get("base_url")
            if not isinstance(provider, str) or not provider:
                raise ValueError(
                    f"Configuration profile '{name}' needs a provider"
                )
            get_provider(provider)
            if not isinstance(model, str) or not model:
                raise ValueError(f"Configuration profile '{name}' needs a model")
            if base_url is not None and not isinstance(base_url, str):
                raise ValueError(
                    f"Configuration profile '{name}' base_url must be a string"
                )

    def _write_document(self, document: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
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
