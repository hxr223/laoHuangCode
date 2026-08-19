"""Built-in model provider presets."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Provider:
    name: str
    default_model: str | None
    base_url: str | None
    api_key_env: str


_PROVIDERS = {
    "custom": Provider(
        name="custom",
        default_model=None,
        base_url=None,
        api_key_env="OPENAI_API_KEY",
    ),
    "deepseek": Provider(
        name="deepseek",
        default_model="deepseek-v4-flash",
        base_url="https://api.deepseek.com",
        api_key_env="DEEPSEEK_API_KEY",
    ),
    "openai": Provider(
        name="openai",
        default_model=None,
        base_url=None,
        api_key_env="OPENAI_API_KEY",
    ),
}


def get_provider(name: str) -> Provider:
    try:
        return _PROVIDERS[name]
    except KeyError as error:
        raise ValueError(f"Unknown provider: {name}") from error


def provider_names() -> tuple[str, ...]:
    return tuple(sorted(_PROVIDERS))
