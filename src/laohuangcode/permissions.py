"""Session-scoped approval policy for tool execution."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any


PermissionPrompt = Callable[[str, dict[str, Any]], str]


class PermissionGate:
    """Allow reads automatically and ask before side-effecting tools."""

    def __init__(
        self,
        *,
        prompt: PermissionPrompt | None = None,
        dangerously_skip_permissions: bool = False,
    ) -> None:
        self.prompt = prompt
        self.dangerously_skip_permissions = dangerously_skip_permissions
        self._allow_for_session = False

    def authorize(self, name: str, arguments: dict[str, Any]) -> bool:
        if name == "read":
            return True
        if self.dangerously_skip_permissions or self._allow_for_session:
            return True
        if self.prompt is None:
            return False

        answer = self.prompt(name, arguments).strip().casefold()
        if answer in {"a", "all"}:
            self._allow_for_session = True
            return True
        return answer in {"y", "yes"}
