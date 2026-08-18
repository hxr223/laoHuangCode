"""The model/tool loop at the heart of laoHuangCode."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from .tools import ToolRegistry


SYSTEM_PROMPT = """You are laoHuangCode, a small coding agent.
Work inside the project root. Use read, write, edit, and bash when needed.
Inspect relevant files before changing them and verify changes when practical.
Keep your final response concise and explain what changed."""


class AgentError(RuntimeError):
    """Raised when the model response cannot drive the agent loop."""


class CodingAgent:
    def __init__(
        self,
        *,
        client: Any,
        model: str,
        tools: ToolRegistry,
        max_tool_rounds: int = 20,
        on_tool_event: Callable[
            [str, dict[str, Any], dict[str, Any]], None
        ]
        | None = None,
    ) -> None:
        self.client = client
        self.model = model
        self.tools = tools
        self.max_tool_rounds = max_tool_rounds
        self.on_tool_event = on_tool_event
        self.messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT}
        ]

    def run(self, user_input: str) -> str:
        self.messages.append({"role": "user", "content": user_input})
        tool_rounds = 0

        while True:
            try:
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=list(self.messages),
                    tools=self.tools.definitions,
                )
            except Exception as error:
                raise AgentError(f"Model request failed: {error}") from error
            if not response.choices:
                raise AgentError("Model returned no choices")

            message = response.choices[0].message
            if message.tool_calls and tool_rounds >= self.max_tool_rounds:
                raise AgentError(
                    f"Agent exceeded the limit of {self.max_tool_rounds} tool rounds"
                )

            self.messages.append(message.model_dump(exclude_none=True))
            if not message.tool_calls:
                if not message.content:
                    raise AgentError("Model returned neither text nor tool calls")
                return message.content

            tool_rounds += 1

            for tool_call in message.tool_calls:
                arguments: dict[str, Any]
                try:
                    decoded = json.loads(tool_call.function.arguments)
                    if not isinstance(decoded, dict):
                        raise ValueError("Tool arguments must be a JSON object")
                    arguments = decoded
                    result = self.tools.execute(tool_call.function.name, arguments)
                except (json.JSONDecodeError, ValueError) as error:
                    arguments = {"_raw": tool_call.function.arguments}
                    result = {"ok": False, "error": str(error)}

                if self.on_tool_event is not None:
                    self.on_tool_event(tool_call.function.name, arguments, result)
                self.messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": json.dumps(result, ensure_ascii=False),
                    }
                )
