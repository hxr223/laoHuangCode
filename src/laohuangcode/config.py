"""Environment-backed configuration for the model client."""

from __future__ import annotations

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Config:
    api_key: str
    model: str
    base_url: str | None = None

    @classmethod
    def from_env(cls) -> "Config":
        required = ("OPENAI_API_KEY", "OPENAI_MODEL")
        missing = [name for name in required if not os.environ.get(name)]
        if missing:
            raise ValueError(
                "Missing required environment variables: " + ", ".join(missing)
            )

        return cls(
            api_key=os.environ["OPENAI_API_KEY"],
            model=os.environ["OPENAI_MODEL"],
            base_url=os.environ.get("OPENAI_BASE_URL"),
        )
