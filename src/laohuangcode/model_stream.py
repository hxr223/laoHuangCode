"""OpenAI-compatible Chat Completions stream assembly and validation."""

from __future__ import annotations

import json
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from uuid import uuid4


class ModelStreamError(RuntimeError):
    """Raised when a streamed model response is incomplete or invalid."""

    def __init__(self, message: str, *, had_delta: bool = False) -> None:
        super().__init__(message)
        self.had_delta = had_delta


class ModelStreamCancelled(ModelStreamError):
    """Raised when a model stream is cooperatively cancelled."""


class StaleModelRequest(ModelStreamCancelled):
    """Raised when chunks arrive for a request which is no longer active."""


class AttemptState(str, Enum):
    PROVISIONAL = "provisional"
    VALIDATED = "validated"
    ABORTED = "aborted"


@dataclass(frozen=True)
class AssembledFunction:
    name: str
    arguments: str


@dataclass(frozen=True)
class AssembledToolCall:
    id: str
    function: AssembledFunction
    type: str = "function"

    def model_dump(self, *, exclude_none: bool = False) -> dict[str, Any]:
        del exclude_none
        return {
            "id": self.id,
            "type": self.type,
            "function": {
                "name": self.function.name,
                "arguments": self.function.arguments,
            },
        }


@dataclass
class ToolCallAccumulator:
    """Assemble fragmented Chat Completions tool calls by their index."""

    index: int
    id_parts: list[str] = field(default_factory=list)
    type_parts: list[str] = field(default_factory=list)
    name_parts: list[str] = field(default_factory=list)
    argument_parts: list[str] = field(default_factory=list)

    def add(self, fragment: Any) -> None:
        call_id = _value(fragment, "id")
        call_type = _value(fragment, "type")
        function = _value(fragment, "function")
        name = _value(function, "name")
        arguments = _value(function, "arguments")
        if call_id:
            self.id_parts.append(str(call_id))
        if call_type and not self.type_parts:
            self.type_parts.append(str(call_type))
        if name:
            self.name_parts.append(str(name))
        if arguments:
            self.argument_parts.append(str(arguments))

    def build(self) -> AssembledToolCall:
        call_id = "".join(self.id_parts)
        call_type = "".join(self.type_parts) or "function"
        name = "".join(self.name_parts)
        arguments = "".join(self.argument_parts)
        if not call_id:
            raise ModelStreamError(
                f"Tool call at index {self.index} has no id"
            )
        if call_type != "function":
            raise ModelStreamError(
                f"Unsupported tool call type at index {self.index}: {call_type}"
            )
        if not name:
            raise ModelStreamError(
                f"Tool call at index {self.index} has no function name"
            )
        try:
            decoded = json.loads(arguments)
        except json.JSONDecodeError as error:
            raise ModelStreamError(
                f"Invalid JSON arguments for tool {name}: {error}"
            ) from error
        if not isinstance(decoded, dict):
            raise ModelStreamError(
                f"Arguments for tool {name} must be a JSON object"
            )
        return AssembledToolCall(
            id=call_id,
            type=call_type,
            function=AssembledFunction(name=name, arguments=arguments),
        )


@dataclass(frozen=True)
class StreamResult:
    request_id: str
    content: str | None
    reasoning_content: str | None
    tool_calls: tuple[AssembledToolCall, ...]
    finish_reason: str
    usage: Any = None

    def message_dict(self) -> dict[str, Any]:
        message: dict[str, Any] = {
            "role": "assistant",
            "content": self.content,
        }
        if self.reasoning_content:
            message["reasoning_content"] = self.reasoning_content
        if self.tool_calls:
            message["tool_calls"] = [
                tool_call.model_dump() for tool_call in self.tool_calls
            ]
        return {key: value for key, value in message.items() if value is not None}


@dataclass
class ModelAttempt:
    """A provisional response which can be atomically committed after validation."""

    request_id: str
    content_parts: list[str] = field(default_factory=list)
    reasoning_parts: list[str] = field(default_factory=list)
    tool_calls: dict[int, ToolCallAccumulator] = field(default_factory=dict)
    finish_reason: str | None = None
    usage: Any = None
    received_delta: bool = False
    state: AttemptState = AttemptState.PROVISIONAL

    @property
    def content(self) -> str:
        return "".join(self.content_parts)

    @property
    def reasoning_content(self) -> str:
        return "".join(self.reasoning_parts)

    def add_choice(self, choice: Any) -> list[tuple[str, dict[str, Any]]]:
        if self.state is not AttemptState.PROVISIONAL:
            raise ModelStreamError("Cannot append to a finished model attempt")
        events: list[tuple[str, dict[str, Any]]] = []
        delta = _value(choice, "delta")
        if delta is not None:
            self.received_delta = True
            content = _value(delta, "content")
            if content:
                text = str(content)
                self.content_parts.append(text)
                events.append(("model_text_delta", {"text": text}))

            reasoning = _value(delta, "reasoning_content")
            if reasoning:
                text = str(reasoning)
                self.reasoning_parts.append(text)
                events.append(("model_reasoning_delta", {"text": text}))

            fragments = _value(delta, "tool_calls") or []
            for fallback_index, fragment in enumerate(fragments):
                raw_index = _value(fragment, "index")
                index = fallback_index if raw_index is None else int(raw_index)
                accumulator = self.tool_calls.setdefault(
                    index, ToolCallAccumulator(index=index)
                )
                accumulator.add(fragment)
                events.append(
                    (
                        "model_tool_call_delta",
                        {
                            "index": index,
                            "id": _value(fragment, "id"),
                            "name": _value(
                                _value(fragment, "function"), "name"
                            ),
                            "arguments": _value(
                                _value(fragment, "function"), "arguments"
                            ),
                        },
                    )
                )

        finish_reason = _value(choice, "finish_reason")
        if finish_reason is not None:
            normalized = str(finish_reason)
            if self.finish_reason not in (None, normalized):
                raise ModelStreamError(
                    "Model stream returned conflicting finish reasons"
                )
            self.finish_reason = normalized
        return events

    def validate(self) -> StreamResult:
        if self.state is not AttemptState.PROVISIONAL:
            raise ModelStreamError("Model attempt has already finished")
        finish_reason = self.finish_reason
        if finish_reason in {
            "length",
            "content_filter",
            "insufficient_system_resource",
        }:
            self.state = AttemptState.ABORTED
            raise ModelStreamError(
                f"Model response aborted with finish_reason={finish_reason}"
            )
        if finish_reason not in {"stop", "tool_calls"}:
            self.state = AttemptState.ABORTED
            if finish_reason is None:
                raise ModelStreamError(
                    "Model stream ended without a finish reason"
                )
            raise ModelStreamError(
                f"Unsupported model finish reason: {finish_reason}"
            )

        try:
            calls = tuple(
                self.tool_calls[index].build()
                for index in sorted(self.tool_calls)
            )
        except ModelStreamError:
            self.state = AttemptState.ABORTED
            raise

        content = self.content or None
        reasoning = self.reasoning_content or None
        if finish_reason == "tool_calls" and not calls:
            self.state = AttemptState.ABORTED
            raise ModelStreamError(
                "Model finished with tool_calls but supplied no tool calls"
            )
        if finish_reason == "stop" and calls:
            self.state = AttemptState.ABORTED
            raise ModelStreamError(
                "Model supplied tool calls with finish_reason=stop"
            )
        if not calls and not content:
            self.state = AttemptState.ABORTED
            raise ModelStreamError("Model returned neither text nor tool calls")

        self.state = AttemptState.VALIDATED
        return StreamResult(
            request_id=self.request_id,
            content=content,
            reasoning_content=reasoning,
            tool_calls=calls,
            finish_reason=finish_reason,
            usage=self.usage,
        )

    def abort(self) -> None:
        if self.state is AttemptState.PROVISIONAL:
            self.state = AttemptState.ABORTED


DeltaCallback = Callable[[str, dict[str, Any]], None]


class ChatCompletionStreamer:
    """Create and assemble one OpenAI-compatible streaming completion."""

    def __init__(self, completions: Any) -> None:
        self.completions = completions

    def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        request_id: str | None = None,
        cancel_token: Any | None = None,
        is_request_active: Callable[[str], bool] | None = None,
        on_delta: DeltaCallback | None = None,
        on_request_opened: Callable[[], bool | None] | None = None,
        max_pre_delta_retries: int = 1,
    ) -> StreamResult:
        request_id = request_id or str(uuid4())
        request = {
            "model": model,
            "messages": messages,
            "tools": tools,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        last_error: Exception | None = None

        for retry in range(max_pre_delta_retries + 1):
            attempt = ModelAttempt(request_id=request_id)
            stream: Any = None
            unregister_cancel: Callable[[], None] = lambda: None
            try:
                _ensure_active(cancel_token, is_request_active, request_id)
                stream = self.completions.create(**request)
                if (
                    on_request_opened is not None
                    and on_request_opened() is False
                ):
                    _close_stream(stream)
                    raise ModelStreamCancelled(
                        "cancelled before model request acknowledgement"
                    )
                if _is_non_stream_response(stream):
                    return self._from_non_stream(stream, request_id)
                register = getattr(cancel_token, "register", None)
                if callable(register):
                    unregister_cancel = register(
                        lambda _reason: _close_stream(stream)
                    )

                for chunk in _iterate_stream(stream):
                    _ensure_active(cancel_token, is_request_active, request_id)
                    choices = _value(chunk, "choices") or []
                    usage = _value(chunk, "usage")
                    if usage is not None:
                        attempt.usage = _dump(usage)
                    if not choices:
                        continue
                    for choice in choices:
                        for event_type, payload in attempt.add_choice(choice):
                            if on_delta is not None:
                                on_delta(
                                    event_type,
                                    {"request_id": request_id, **payload},
                                )

                _ensure_active(cancel_token, is_request_active, request_id)
                if on_delta is not None:
                    on_delta(
                        "model_response_validating",
                        {"request_id": request_id},
                    )
                return attempt.validate()
            except (ModelStreamCancelled, StaleModelRequest):
                attempt.abort()
                _close_stream(stream)
                raise
            except Exception as error:
                attempt.abort()
                _close_stream(stream)
                last_error = error
                if _is_cancelled(cancel_token):
                    reason = getattr(cancel_token, "reason", None) or "cancelled"
                    raise ModelStreamCancelled(str(reason)) from error
                if (
                    is_request_active is not None
                    and not is_request_active(request_id)
                ):
                    raise StaleModelRequest(
                        f"Stale model request: {request_id}"
                    ) from error
                if attempt.received_delta or retry >= max_pre_delta_retries:
                    if isinstance(error, ModelStreamError):
                        error.had_delta = attempt.received_delta
                        raise
                    raise ModelStreamError(
                        str(error), had_delta=attempt.received_delta
                    ) from error
            finally:
                unregister_cancel()

        assert last_error is not None
        raise ModelStreamError(str(last_error)) from last_error

    @staticmethod
    def _from_non_stream(response: Any, request_id: str) -> StreamResult:
        """Compatibility path for old tests and OpenAI-compatible fake clients."""
        choices = _value(response, "choices") or []
        if not choices:
            raise ModelStreamError("Model returned no choices")
        choice = choices[0]
        message = _value(choice, "message")
        if message is None:
            raise ModelStreamError("Model response has no message")

        raw_tool_calls = _value(message, "tool_calls") or []
        content = _value(message, "content") or None
        reasoning = _value(message, "reasoning_content") or None
        finish_reason = _value(choice, "finish_reason")
        if finish_reason is None:
            finish_reason = "tool_calls" if raw_tool_calls else "stop"
        attempt = ModelAttempt(
            request_id=request_id,
            content_parts=[str(content)] if content else [],
            reasoning_parts=[str(reasoning)] if reasoning else [],
            tool_calls={
                index: _accumulator_from_call(index, call)
                for index, call in enumerate(raw_tool_calls)
            },
            finish_reason=str(finish_reason),
            usage=_dump(_value(response, "usage")),
        )
        return attempt.validate()


def _accumulator_from_call(index: int, call: Any) -> ToolCallAccumulator:
    accumulator = ToolCallAccumulator(index=index)
    accumulator.add(call)
    return accumulator


def _value(value: Any, key: str, default: Any = None) -> Any:
    if value is None:
        return default
    if isinstance(value, Mapping):
        return value.get(key, default)
    return getattr(value, key, default)


def _dump(value: Any) -> Any:
    if value is None:
        return None
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        return model_dump(exclude_none=True)
    if isinstance(value, Mapping):
        return dict(value)
    return value


def _is_non_stream_response(response: Any) -> bool:
    choices = _value(response, "choices")
    return bool(choices) and _value(choices[0], "message") is not None


def _iterate_stream(stream: Any) -> Iterator[Any]:
    try:
        iterator = iter(stream)
    except TypeError as error:
        raise ModelStreamError("Model returned a non-iterable stream") from error
    yield from iterator


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


def _ensure_active(
    cancel_token: Any | None,
    is_request_active: Callable[[str], bool] | None,
    request_id: str,
) -> None:
    if _is_cancelled(cancel_token):
        reason = getattr(cancel_token, "reason", None) or "cancelled"
        raise ModelStreamCancelled(str(reason))
    if is_request_active is not None and not is_request_active(request_id):
        raise StaleModelRequest(f"Stale model request: {request_id}")


def _close_stream(stream: Any) -> None:
    close = getattr(stream, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass
