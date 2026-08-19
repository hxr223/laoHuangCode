"""The model/tool loop at the heart of laoHuangCode."""

from __future__ import annotations

import inspect
import json
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any
from uuid import uuid4

from .model_stream import (
    ChatCompletionStreamer,
    ModelStreamCancelled,
    ModelStreamError,
    StaleModelRequest,
)
from .tools import ToolExecutionMode, ToolRegistry


AgentEventCallback = Callable[[str, dict[str, Any]], None]


SYSTEM_PROMPT = """You are laoHuangCode, a small coding agent.
Work inside the project root. Use read, write, edit, and bash when needed.
Inspect relevant files before changing them and verify changes when practical.
Keep your final response concise and explain what changed."""


class AgentError(RuntimeError):
    """Raised when the model response cannot drive the agent loop."""


class AgentCancelled(AgentError):
    """Raised when the active agent task is cooperatively cancelled."""


def _is_authentication_error(error: Exception) -> bool:
    status_code = getattr(error, "status_code", None)
    if status_code is None:
        response = getattr(error, "response", None)
        status_code = getattr(response, "status_code", None)
    if status_code == 401 or type(error).__name__ == "AuthenticationError":
        return True
    cause = error.__cause__
    return isinstance(cause, Exception) and _is_authentication_error(cause)


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
        provider: str | None = None,
        tool_execution: ToolExecutionMode = "parallel",
    ) -> None:
        self.client = client
        self.model = model
        self.tools = tools
        self.max_tool_rounds = max_tool_rounds
        self.on_tool_event = on_tool_event
        self.on_agent_event = on_agent_event
        self.provider = provider
        self.tool_execution = tool_execution
        self.messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT}
        ]
        self._turn = 0
        self._active_context: Any | None = None
        self._active_request_id: str | None = None

    def switch_model(self, *, client: Any, model: str, provider: str) -> None:
        previous_model = self.model
        previous_provider = self.provider
        self.messages = [self._portable_message(message) for message in self.messages]
        self.client = client
        self.model = model
        self.provider = provider
        self._emit(
            "model_switched",
            {
                "provider": provider,
                "model": model,
                "previous_model": previous_model,
                "previous_provider": previous_provider,
            },
        )

    @staticmethod
    def _portable_message(message: dict[str, Any]) -> dict[str, Any]:
        role = message.get("role")
        portable: dict[str, Any] = {"role": role}
        if "content" in message:
            portable["content"] = message["content"]
        if role == "assistant" and message.get("tool_calls"):
            portable["tool_calls"] = [
                {
                    "id": call["id"],
                    "type": call.get("type", "function"),
                    "function": {
                        "name": call["function"]["name"],
                        "arguments": call["function"]["arguments"],
                    },
                }
                for call in message["tool_calls"]
            ]
        if role == "tool":
            portable["tool_call_id"] = message["tool_call_id"]
        return portable

    def run(
        self,
        user_input: str,
        context: Any | None = None,
        *,
        cancel_token: Any | None = None,
        request_id: str | None = None,
        is_request_active: Callable[[str], bool] | None = None,
    ) -> str:
        """Run one user turn, committing only fully validated model attempts."""
        if context is not None and cancel_token is None:
            cancel_token = getattr(context, "cancel_token", None)
        self._active_context = context
        self._turn += 1
        tool_rounds = 0
        model_round = 0

        try:
            user_message = {"role": "user", "content": user_input}
            commit_input = getattr(context, "commit_input", None)
            if callable(commit_input):
                committed = self._commit_context_message(
                    commit_input, user_message
                )
            else:
                self._raise_if_cancelled(cancel_token)
                self.messages.append(user_message)
                committed = True
            if not committed:
                raise AgentCancelled("cancelled before user input commit")
            self._emit("user_message", {"content": user_input})
            while True:
                self._raise_if_cancelled(cancel_token)
                model_started = getattr(context, "model_started", None)
                if callable(model_started):
                    if model_started() is False:
                        raise AgentCancelled("cancelled before model request")
                model_round += 1
                current_request_id = (
                    request_id if model_round == 1 and request_id else str(uuid4())
                )
                self._active_request_id = current_request_id
                self._emit(
                    "model_request",
                    {
                        "round": model_round,
                        "request_id": current_request_id,
                        "message_count": len(self.messages),
                    },
                )
                try:
                    result = ChatCompletionStreamer(
                        self.client.chat.completions
                    ).complete(
                        model=self.model,
                        messages=list(self.messages),
                        tools=self.tools.definitions,
                        request_id=current_request_id,
                        cancel_token=cancel_token,
                        is_request_active=(
                            is_request_active or self._is_active_request
                        ),
                        on_delta=lambda event_type, payload: self._emit(
                            event_type,
                            {"round": model_round, **payload},
                        ),
                        on_request_opened=getattr(
                            context, "model_request_opened", None
                        ),
                    )
                except (ModelStreamCancelled, StaleModelRequest) as error:
                    self._emit(
                        "model_response_aborted",
                        {
                            "round": model_round,
                            "request_id": current_request_id,
                            "reason": str(error),
                        },
                    )
                    raise AgentCancelled(str(error)) from error
                except Exception as error:
                    error_payload = {
                        "round": model_round,
                        "request_id": current_request_id,
                        "error": str(error),
                    }
                    if (
                        isinstance(error, ModelStreamError)
                        and error.had_delta
                    ):
                        self._emit("model_response_aborted", error_payload)
                        self._emit_legacy("model_error", error_payload)
                    else:
                        self._emit("model_error", error_payload)
                    message = f"Model request failed: {error}"
                    if _is_authentication_error(error) and self.provider:
                        message += (
                            f"\nAuthentication failed for {self.provider}. "
                            f"Run /login {self.provider} to update your API key."
                        )
                    raise AgentError(message) from error

                tool_calls = list(result.tool_calls)
                self._emit(
                    "model_response",
                    {
                        "round": model_round,
                        "request_id": current_request_id,
                        "finish_reason": result.finish_reason,
                        "tool_call_count": len(tool_calls),
                        "tool_names": [call.function.name for call in tool_calls],
                        "tool_call_ids": [call.id for call in tool_calls],
                        "usage": result.usage,
                    },
                )
                if tool_calls and tool_rounds >= self.max_tool_rounds:
                    self._emit(
                        "agent_error",
                        {
                            "round": model_round,
                            "error": (
                                f"tool round limit {self.max_tool_rounds} exceeded"
                            ),
                        },
                    )
                    raise AgentError(
                        "Agent exceeded the limit of "
                        f"{self.max_tool_rounds} tool rounds"
                    )

                # The complete assistant message is committed only if
                # cancellation has not won the Session coordination race.
                assistant_message = result.message_dict()
                commit_if_active = getattr(context, "commit_if_active", None)
                if callable(commit_if_active):
                    committed = commit_if_active(
                        lambda: self.messages.append(assistant_message)
                    )
                else:
                    self._raise_if_cancelled(cancel_token)
                    self.messages.append(assistant_message)
                    committed = True
                if not committed:
                    self._emit(
                        "model_response_aborted",
                        {
                            "round": model_round,
                            "request_id": current_request_id,
                            "reason": "cancelled before history commit",
                        },
                    )
                    raise AgentCancelled("cancelled before history commit")
                self._emit(
                    "model_response_committed",
                    {
                        "round": model_round,
                        "request_id": current_request_id,
                    },
                )
                if not tool_calls:
                    assert result.content is not None
                    self._emit(
                        "assistant_response",
                        {
                            "round": model_round,
                            "content": self._truncate_for_event(result.content),
                        },
                    )
                    return result.content

                tool_rounds += 1
                tools_started = getattr(context, "tools_started", None)
                if callable(tools_started):
                    tools_started()
                tool_results = self._execute_tool_batch(
                    tool_calls,
                    model_round,
                    cancel_token=cancel_token,
                    context=context,
                )
                # Every committed assistant tool call must receive one paired
                # tool result, including calls cancelled before they start.
                for tool_call, tool_result in zip(
                    tool_calls, tool_results, strict=True
                ):
                    self.messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tool_call.id,
                            "content": json.dumps(
                                tool_result, ensure_ascii=False
                            ),
                        }
                    )
                self._raise_if_cancelled(cancel_token)
                safe_point = getattr(context, "safe_point", None)
                if callable(safe_point):
                    pending_batch = safe_point()
                    pending_content = getattr(pending_batch, "content", "")
                    if pending_content:
                        pending_message = {
                            "role": "user",
                            "content": pending_content,
                        }
                        commit_pending = getattr(
                            context, "commit_pending", None
                        )
                        if callable(commit_pending):
                            committed = self._commit_context_message(
                                commit_pending,
                                pending_message,
                                leading_arguments=(pending_batch,),
                            )
                        else:
                            self._raise_if_cancelled(cancel_token)
                            self.messages.append(pending_message)
                            committed = True
                        if not committed:
                            raise AgentCancelled(
                                "cancelled before pending input commit"
                            )
                        self._emit(
                            "user_message",
                            {
                                "content": pending_content,
                                "pending_event_ids": list(
                                    getattr(pending_batch, "event_ids", ())
                                ),
                            },
                        )
        finally:
            self._active_request_id = None
            self._active_context = None

    def _commit_context_message(
        self,
        commit: Callable[..., bool],
        message: dict[str, Any],
        *,
        leading_arguments: tuple[Any, ...] = (),
    ) -> bool:
        def append() -> None:
            self.messages.append(message)

        def rollback() -> None:
            if self.messages and self.messages[-1] is message:
                self.messages.pop()

        try:
            supports_rollback = "rollback" in inspect.signature(commit).parameters
        except (TypeError, ValueError):
            supports_rollback = False
        if supports_rollback:
            return bool(
                commit(*leading_arguments, append, rollback=rollback)
            )
        return bool(commit(*leading_arguments, append))

    def _execute_tool_batch(
        self,
        tool_calls: list[Any],
        model_round: int,
        *,
        cancel_token: Any | None = None,
        context: Any | None = None,
    ) -> list[dict[str, Any]]:
        results: list[dict[str, Any] | None] = [None] * len(tool_calls)
        prepared: list[
            tuple[int, Any, dict[str, Any], dict[str, Any]]
        ] = []

        for offset, tool_call in enumerate(tool_calls):
            index = offset + 1
            arguments: dict[str, Any]
            try:
                decoded = json.loads(tool_call.function.arguments)
                if not isinstance(decoded, dict):
                    raise ValueError("Tool arguments must be a JSON object")
                arguments = decoded
            except (json.JSONDecodeError, ValueError) as error:
                arguments = {"_raw": tool_call.function.arguments}
                result: dict[str, Any] | None = {
                    "ok": False,
                    "error": str(error),
                }
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
                prepared.append((offset, tool_call, arguments, event_context))

            if result is not None:
                results[offset] = result
                self._finish_tool_event(
                    tool_call.function.name,
                    arguments,
                    result,
                    event_context,
                )

        sequential_batch = self.tool_execution == "sequential" or any(
            self.tools.execution_mode(tool_call.function.name) == "sequential"
            for tool_call in tool_calls
        ) or any(
            tool_call.function.name in {"write", "edit"}
            for tool_call in tool_calls
        )
        if sequential_batch:
            for offset, tool_call, arguments, event_context in prepared:
                if self._is_cancelled(cancel_token):
                    result = self._cancelled_tool_result(cancel_token)
                else:
                    result = self._execute_tool(
                        tool_call.function.name,
                        arguments,
                        tool_call_id=tool_call.id,
                        cancel_token=cancel_token,
                        context=context,
                    )
                results[offset] = result
                self._finish_tool_event(
                    tool_call.function.name,
                    arguments,
                    result,
                    event_context,
                )
        elif len(prepared) == 1:
            offset, tool_call, arguments, event_context = prepared[0]
            if self._is_cancelled(cancel_token):
                result = self._cancelled_tool_result(cancel_token)
            else:
                result = self._execute_tool(
                    tool_call.function.name,
                    arguments,
                    tool_call_id=tool_call.id,
                    cancel_token=cancel_token,
                    context=context,
                )
            results[offset] = result
            self._finish_tool_event(
                tool_call.function.name, arguments, result, event_context
            )
        elif prepared:
            with ThreadPoolExecutor(max_workers=len(prepared)) as executor:
                futures = {
                    executor.submit(
                        self._execute_tool,
                        tool_call.function.name,
                        arguments,
                        tool_call_id=tool_call.id,
                        cancel_token=cancel_token,
                        context=context,
                    ): (offset, tool_call, arguments, event_context)
                    for offset, tool_call, arguments, event_context in prepared
                }
                for future in as_completed(futures):
                    offset, tool_call, arguments, event_context = futures[future]
                    result = future.result()
                    results[offset] = result
                    self._finish_tool_event(
                        tool_call.function.name,
                        arguments,
                        result,
                        event_context,
                    )

        return [
            result
            if result is not None
            else {"ok": False, "error": "Tool execution produced no result"}
            for result in results
        ]

    def _execute_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        *,
        tool_call_id: str | None = None,
        cancel_token: Any | None = None,
        context: Any | None = None,
    ) -> dict[str, Any]:
        if self._is_cancelled(cancel_token):
            return self._cancelled_tool_result(cancel_token)
        try:
            tool_context = self._make_tool_context(
                context=context,
                tool_call_id=tool_call_id,
                cancel_token=cancel_token,
            )
            parameters = inspect.signature(self.tools.execute).parameters
            if "context" in parameters:
                return self.tools.execute(name, arguments, context=tool_context)
            return self.tools.execute(name, arguments)
        except Exception as error:
            return {"ok": False, "error": str(error)}

    @staticmethod
    def _make_tool_context(
        *,
        context: Any | None,
        tool_call_id: str | None,
        cancel_token: Any | None,
    ) -> Any | None:
        try:
            from .tools import ToolExecutionContext
        except ImportError:
            return None
        return ToolExecutionContext(
            session_id=getattr(context, "session_id", None),
            task_id=getattr(context, "task_id", None),
            tool_call_id=tool_call_id,
            cancel_token=cancel_token,
            event_sink=(
                (
                    lambda kind, payload: context.publish(
                        kind,
                        source="tool",
                        correlation_id=tool_call_id,
                        payload=payload,
                    )
                )
                if callable(getattr(context, "publish", None))
                else getattr(context, "event_bus", None)
            ),
        )

    @staticmethod
    def _is_cancelled(cancel_token: Any | None) -> bool:
        if cancel_token is None:
            return False
        checker = getattr(cancel_token, "is_cancelled", None)
        if callable(checker):
            return bool(checker())
        checker = getattr(cancel_token, "is_set", None)
        if callable(checker):
            return bool(checker())
        return bool(getattr(cancel_token, "cancelled", False))

    @classmethod
    def _raise_if_cancelled(cls, cancel_token: Any | None) -> None:
        if cls._is_cancelled(cancel_token):
            reason = getattr(cancel_token, "reason", None) or "cancelled"
            raise AgentCancelled(str(reason))

    @staticmethod
    def _cancelled_tool_result(cancel_token: Any | None) -> dict[str, Any]:
        reason = getattr(cancel_token, "reason", None) or "cancelled"
        return {"ok": False, "status": "cancelled", "error": str(reason)}

    def _is_active_request(self, request_id: str) -> bool:
        return self._active_request_id == request_id

    def _finish_tool_event(
        self,
        name: str,
        arguments: dict[str, Any],
        result: dict[str, Any],
        event_context: dict[str, Any],
    ) -> None:
        if self.on_tool_event is not None:
            self.on_tool_event(name, arguments, result)
        self._emit(
            "tool_result",
            {
                **event_context,
                "status": result.get("status")
                or ("completed" if result.get("ok") else "failed"),
                "result": self._safe_result(result),
            },
        )

    def _emit(self, event_type: str, payload: dict[str, Any]) -> None:
        full_payload = {"turn": self._turn, **payload}
        self._emit_legacy(event_type, full_payload, add_turn=False)
        self._publish_runtime_event(event_type, full_payload)

    def _emit_legacy(
        self,
        event_type: str,
        payload: dict[str, Any],
        *,
        add_turn: bool = True,
    ) -> None:
        if self.on_agent_event is not None:
            body = {"turn": self._turn, **payload} if add_turn else payload
            self.on_agent_event(event_type, body)

    def _publish_runtime_event(
        self, event_type: str, payload: dict[str, Any]
    ) -> None:
        context = self._active_context
        publisher = getattr(context, "publish", None)
        bus = getattr(context, "event_bus", None)
        if not callable(publisher) and bus is None:
            return
        kind_names = {
            "model_request": "MODEL_REQUEST_STARTED",
            "model_text_delta": "MODEL_TEXT_DELTA",
            "model_reasoning_delta": "MODEL_REASONING_DELTA",
            "model_tool_call_delta": "MODEL_TOOL_CALL_DELTA",
            "model_response_validating": "MODEL_RESPONSE_VALIDATING",
            "model_response_committed": "MODEL_RESPONSE_COMMITTED",
            "model_response_aborted": "MODEL_RESPONSE_ABORTED",
            "model_error": "MODEL_REQUEST_FAILED",
            "tool_start": "TOOL_STARTED",
            "tool_result": "TOOL_FINISHED",
        }
        kind_name = kind_names.get(event_type)
        if kind_name is None:
            return
        # Streaming Bash owns its own start/output/finish events. The Agent
        # supplies lifecycle events for the three synchronous file tools.
        is_tool_event = event_type in {"tool_start", "tool_result"}
        if is_tool_event and payload.get("name") == "bash":
            return
        from .events import EventKind, EventSource

        options = {
            "source": EventSource.TOOL if is_tool_event else EventSource.MODEL,
            "correlation_id": (
                payload.get("tool_call_id")
                if is_tool_event
                else payload.get("request_id")
            ),
            "payload": payload,
        }
        if callable(publisher):
            publisher(getattr(EventKind, kind_name), **options)
        else:
            bus.publish(
                getattr(EventKind, kind_name),
                session_id=getattr(context, "session_id", None) or "local",
                task_id=getattr(context, "task_id", None),
                **options,
            )

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
