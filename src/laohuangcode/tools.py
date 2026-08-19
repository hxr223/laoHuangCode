"""Tool definitions and execution for the coding agent."""

from __future__ import annotations

import os
from pathlib import Path
import subprocess
from typing import Any


TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "read",
            "description": "Read a UTF-8 text file inside the project root.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path."}
                },
                "required": ["path"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write",
            "description": "Create or fully overwrite a UTF-8 text file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path."},
                    "content": {"type": "string", "description": "Full file content."},
                },
                "required": ["path", "content"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit",
            "description": "Replace one exact, unique text occurrence in a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path."},
                    "old_text": {"type": "string", "description": "Exact text to replace."},
                    "new_text": {"type": "string", "description": "Replacement text."},
                },
                "required": ["path", "old_text", "new_text"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run a Bash command in the project root.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Bash command."}
                },
                "required": ["command"],
                "additionalProperties": False,
            },
        },
    },
]

MODEL_API_KEY_ENV_NAMES = (
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "LAOHUANG_API_KEY",
)


class ToolRegistry:
    """Execute the small set of tools exposed to the model."""

    def __init__(
        self,
        root: Path,
        *,
        bash_timeout: float = 120,
        max_output_chars: int = 20_000,
    ) -> None:
        self.root = root.resolve()
        self.bash_timeout = bash_timeout
        self.max_output_chars = max_output_chars

    @property
    def definitions(self) -> list[dict[str, Any]]:
        return TOOL_DEFINITIONS

    def execute(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            if name == "read":
                path = self._resolve_path(arguments["path"])
                content = path.read_text(encoding="utf-8")
                return {"ok": True, "content": self._truncate(content)}

            if name == "write":
                path = self._resolve_path(arguments["path"])
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(arguments["content"], encoding="utf-8")
                return {"ok": True, "path": arguments["path"]}

            if name == "edit":
                path = self._resolve_path(arguments["path"])
                content = path.read_text(encoding="utf-8")
                old_text = arguments["old_text"]
                matches = content.count(old_text)
                if matches != 1:
                    raise ValueError(
                        f"old_text must appear exactly once; found {matches} matches"
                    )
                path.write_text(
                    content.replace(old_text, arguments["new_text"], 1),
                    encoding="utf-8",
                )
                return {"ok": True, "path": arguments["path"]}

            if name == "bash":
                environment = os.environ.copy()
                for variable_name in MODEL_API_KEY_ENV_NAMES:
                    environment.pop(variable_name, None)
                completed = subprocess.run(
                    ["/bin/bash", "-lc", arguments["command"]],
                    cwd=self.root,
                    env=environment,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=self.bash_timeout,
                    check=False,
                )
                return {
                    "ok": completed.returncode == 0,
                    "exit_code": completed.returncode,
                    "stdout": self._truncate(completed.stdout),
                    "stderr": self._truncate(completed.stderr),
                }

            raise ValueError(f"Unknown tool: {name}")
        except subprocess.TimeoutExpired:
            return {
                "ok": False,
                "error": f"Bash command timed out after {self.bash_timeout} seconds",
            }
        except (KeyError, OSError, TypeError, ValueError) as error:
            return {"ok": False, "error": str(error)}

    def _resolve_path(self, raw_path: str) -> Path:
        path = (self.root / raw_path).resolve()
        try:
            path.relative_to(self.root)
        except ValueError as error:
            raise ValueError(f"Path is outside the project root: {raw_path}") from error
        return path

    def _truncate(self, text: str) -> str:
        if len(text) <= self.max_output_chars:
            return text
        omitted = len(text) - self.max_output_chars
        return text[: self.max_output_chars] + f"\n...[truncated {omitted} chars]"
