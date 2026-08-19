"""The model/tool loop at the heart of laoHuangCode."""

from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

from .tools import ToolRegistry


AgentEventCallback = Callable[[str, dict[str, Any]], None]


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
        on_agent_event: AgentEventCallback | None = None,
    ) -> None:
        self.client = client
        self.model = model
        self.tools = tools
        self.max_tool_rounds = max_tool_rounds
        self.on_tool_event = on_tool_event
        self.on_agent_event = on_agent_event
        self.messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT}
        ]
        self._turn = 0

    def run(self, user_input: str) -> str:
        self._turn += 1
        self.messages.append({"role": "user", "content": user_input})
        self._emit("user_message", {"content": user_input})
        tool_rounds = 0
        model_round = 0

        while True:
            model_round += 1
            self._emit(
                "model_request",
                {"round": model_round, "message_count": len(self.messages)},
            )
            try:
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=list(self.messages),
                    tools=self.tools.definitions,
                )
            except Exception as error:
                self._emit(
                    "model_error", {"round": model_round, "error": str(error)}
                )
                raise AgentError(f"Model request failed: {error}") from error
            if not response.choices:
                self._emit(
                    "model_error", {"round": model_round, "error": "no choices"}
                )
                raise AgentError("Model returned no choices")

            message = response.choices[0].message
            tool_calls = list(message.tool_calls or [])
            self._emit(
                "model_response",
                {
                    "round": model_round,
                    "tool_call_count": len(tool_calls),
                    "tool_names": [call.function.name for call in tool_calls],
                    "tool_call_ids": [call.id for call in tool_calls],
                },
            )
            if tool_calls and tool_rounds >= self.max_tool_rounds:
                self._emit(
                    "agent_error",
                    {
                        "round": model_round,
                        "error": f"tool round limit {self.max_tool_rounds} exceeded",
                    },
                )
                raise AgentError(
                    f"Agent exceeded the limit of {self.max_tool_rounds} tool rounds"
                )

            self.messages.append(message.model_dump(exclude_none=True))
            if not tool_calls:
                if not message.content:
                    self._emit(
                        "agent_error",
                        {
                            "round": model_round,
                            "error": "empty model response",
                        },
                    )
                    raise AgentError("Model returned neither text nor tool calls")
                self._emit(
                    "assistant_response",
                    {
                        "round": model_round,
                        "content": self._truncate_for_event(message.content),
                    },
                )
                return message.content

            tool_rounds += 1

            for index, tool_call in enumerate(tool_calls, start=1):
                arguments: dict[str, Any]
                try:
                    decoded = json.loads(tool_call.function.arguments)
                    if not isinstance(decoded, dict):
                        raise ValueError("Tool arguments must be a JSON object")
                    arguments = decoded
                except (json.JSONDecodeError, ValueError) as error:
                    arguments = {"_raw": tool_call.function.arguments}
                    result = {"ok": False, "error": str(error)}
                else:
                    result = None

                event_context = {
                    "round": model_round,
                    "index": index,
                    "batch_size": len(tool_calls),
                    "tool_call_id": tool_call.id,
                    "name": tool_call.function.name,
                }
                self._emit(
                    "tool_start",
                    {
                        **event_context,
                        "arguments": self._safe_arguments(arguments),
                    },
                )
                if result is None:
                    result = self.tools.execute(tool_call.function.name, arguments)

                if self.on_tool_event is not None:
                    self.on_tool_event(tool_call.function.name, arguments, result)
                self._emit(
                    "tool_result",
                    {
                        **event_context,
                        "result": self._safe_result(result),
                    },
                )
                self.messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": json.dumps(result, ensure_ascii=False),
                    }
                )

    def _emit(self, event_type: str, payload: dict[str, Any]) -> None:
        if self.on_agent_event is not None:
            self.on_agent_event(event_type, {"turn": self._turn, **payload})

    @classmethod
    def _safe_arguments(cls, arguments: dict[str, Any]) -> dict[str, Any]:
        safe = dict(arguments)
        for key in ("content", "old_text", "new_text"):
            value = safe.get(key)
            if isinstance(value, str):
                safe[key] = f"<{len(value)} chars>"
        return {
            key: cls._truncate_for_event(value) if isinstance(value, str) else value
            for key, value in safe.items()
        }

    @classmethod
    def _safe_result(cls, result: dict[str, Any]) -> dict[str, Any]:
        return {
            key: cls._truncate_for_event(value) if isinstance(value, str) else value
            for key, value in result.items()
        }

    @staticmethod
    def _truncate_for_event(value: str, limit: int = 4_000) -> str:
        if len(value) <= limit:
            return value
        return value[:limit] + f"\n...[truncated {len(value) - limit} chars]"
