"""Event-reduced terminal state, independent from the agent runtime."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping


@dataclass(slots=True)
class ActiveResponse:
    request_id: str
    text: str = ""
    status: str = "provisional"


@dataclass(slots=True)
class ActiveTool:
    tool_call_id: str
    name: str
    subject: str = ""
    stdout: str = ""
    stderr: str = ""
    status: str = "running"


@dataclass(slots=True)
class UIState:
    session_state: str = "IDLE"
    active_response: ActiveResponse | None = None
    active_tools: dict[str, ActiveTool] = field(default_factory=dict)
    pending_count: int = 0
    held_count: int = 0
    provider: str = ""
    model: str = ""


@dataclass(frozen=True, slots=True)
class UIUpdate:
    kind: str
    text: str = ""
    correlation_id: str = ""
    stream: str = ""
    payload: Mapping[str, Any] = field(default_factory=dict)


class UIEventReducer:
    """Turn canonical events or projected dictionaries into small UI updates."""

    _TOOL_BUFFER_LIMIT = 20_000

    def __init__(self, state: UIState | None = None) -> None:
        self.state = state or UIState()

    def apply(self, event: Any) -> UIUpdate | None:
        kind = self._kind(event)
        payload = self._payload(event)
        correlation_id = self._correlation_id(event)

        if kind == "ui.message":
            return UIUpdate(
                kind=kind,
                text=str(payload.get("text", "")),
                payload=payload,
            )

        if kind == "task.state_changed":
            raw_state = payload.get("state", "IDLE")
            self.state.session_state = str(
                getattr(raw_state, "value", raw_state)
            ).upper()
            self._update_counts(payload)
            return UIUpdate(kind=kind, payload=payload)
        if kind in {"input.pending", "input.held"}:
            self._update_counts(payload)
            return UIUpdate(kind=kind, payload=payload)
        if kind == "task.started":
            self.state.session_state = "RUNNING_MODEL"
            self._update_counts(payload)
            return UIUpdate(kind=kind, payload=payload)
        if kind in {"task.completed", "task.cancelled", "task.failed"}:
            self.state.session_state = "IDLE" if kind != "task.failed" else "FAILED"
            self._update_counts(payload)
            return UIUpdate(kind=kind, payload=payload)

        if kind == "model.request_started":
            self.state.session_state = "RUNNING_MODEL"
            self.state.active_response = ActiveResponse(correlation_id)
            return UIUpdate(kind=kind, correlation_id=correlation_id, payload=payload)
        if kind == "model.text_delta":
            text = str(payload.get("text", payload.get("chunk", "")))
            response = self.state.active_response
            if response is None or response.request_id != correlation_id:
                response = ActiveResponse(correlation_id)
                self.state.active_response = response
            response.text += text
            return UIUpdate(kind=kind, text=text, correlation_id=correlation_id)
        if kind == "model.response_committed":
            if self.state.active_response is not None:
                self.state.active_response.status = "committed"
            return UIUpdate(kind=kind, correlation_id=correlation_id, payload=payload)
        if kind in {"model.response_aborted", "model.request_failed"}:
            if self.state.active_response is not None:
                self.state.active_response.status = "aborted"
            return UIUpdate(kind=kind, correlation_id=correlation_id, payload=payload)

        if kind == "tool.started":
            name = str(payload.get("name", "tool"))
            arguments = payload.get("arguments", {})
            subject = ""
            if isinstance(arguments, Mapping):
                subject = str(arguments.get("command") or arguments.get("path") or "")
            tool = ActiveTool(correlation_id, name, subject)
            self.state.active_tools[correlation_id] = tool
            self.state.session_state = "RUNNING_TOOLS"
            return UIUpdate(kind=kind, correlation_id=correlation_id, payload=payload)
        if kind == "tool.output_delta":
            stream = str(payload.get("stream", "stdout"))
            if stream == "stdout":
                # Stdout remains available to the model in the tool result,
                # but it is intentionally absent from user-facing UI state.
                return None
            text = str(payload.get("text", payload.get("chunk", "")))
            tool = self.state.active_tools.get(correlation_id)
            if tool is not None:
                tool.stderr = (tool.stderr + text)[-self._TOOL_BUFFER_LIMIT :]
            return UIUpdate(
                kind=kind,
                text=text,
                correlation_id=correlation_id,
                stream=stream,
            )
        if kind == "tool.finished":
            tool = self.state.active_tools.pop(correlation_id, None)
            if tool is not None:
                tool.status = str(payload.get("status", "completed"))
            return UIUpdate(kind=kind, correlation_id=correlation_id, payload=payload)

        if kind == "model.switched":
            self.state.provider = str(payload.get("provider", self.state.provider))
            self.state.model = str(payload.get("model", self.state.model))
            return UIUpdate(kind=kind, payload=payload)

        return None

    def _update_counts(self, payload: Mapping[str, Any]) -> None:
        if "pending_count" in payload:
            self.state.pending_count = int(payload["pending_count"])
        if "held_count" in payload:
            self.state.held_count = int(payload["held_count"])

    @staticmethod
    def _kind(event: Any) -> str:
        raw = event.get("kind", event.get("type", "")) if isinstance(event, Mapping) else getattr(event, "kind", "")
        return str(getattr(raw, "value", raw))

    @staticmethod
    def _payload(event: Any) -> Mapping[str, Any]:
        payload = event.get("payload", {}) if isinstance(event, Mapping) else getattr(event, "payload", {})
        return payload if isinstance(payload, Mapping) else {}

    @staticmethod
    def _correlation_id(event: Any) -> str:
        raw = event.get("correlation_id", "") if isinstance(event, Mapping) else getattr(event, "correlation_id", "")
        return str(raw or "")
