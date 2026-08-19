"""Canonical events and the thread-safe event bus used by the runtime."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from enum import StrEnum
from queue import Empty, Full, Queue
import re
from threading import Lock, Thread, current_thread
from types import MappingProxyType
from typing import Any
from uuid import uuid4


class EventKind(StrEnum):
    """Namespaced event kinds shared by the runtime and its projections."""

    INPUT_USER_MESSAGE = "input.user_message"
    INPUT_RECEIVED = "input.user_message"  # compatibility alias
    INPUT_SLASH_COMMAND = "input.slash_command"
    INPUT_PENDING = "input.pending"
    INPUT_HELD = "input.held"
    INPUT_CANCEL_REQUESTED = "input.cancel_requested"

    TASK_STARTED = "task.started"
    TASK_STATE_CHANGED = "task.state_changed"
    TASK_COMPLETED = "task.completed"
    TASK_FAILED = "task.failed"
    TASK_CANCELLED = "task.cancelled"

    MODEL_REQUEST_STARTED = "model.request_started"
    MODEL_TEXT_DELTA = "model.text_delta"
    MODEL_REASONING_DELTA = "model.reasoning_delta"
    MODEL_TOOL_CALL_DELTA = "model.tool_call_delta"
    MODEL_RESPONSE_VALIDATING = "model.response_validating"
    MODEL_RESPONSE_COMMITTED = "model.response_committed"
    MODEL_RESPONSE_ABORTED = "model.response_aborted"
    MODEL_REQUEST_FAILED = "model.request_failed"
    MODEL_SWITCHED = "model.switched"

    TOOL_STARTED = "tool.started"
    TOOL_OUTPUT_DELTA = "tool.output_delta"
    TOOL_FINISHED = "tool.finished"

    SESSION_READY = "session.ready"
    SESSION_STOPPED = "session.stopped"
    UI_MESSAGE = "ui.message"
    ROUTING_DECIDED = "routing.decided"
    ROUTE_DECIDED = "routing.decided"  # compatibility alias
    ROUTING_REJECTED = "routing.rejected"


class EventSource(StrEnum):
    USER = "user"
    CLI = "cli"
    MODEL = "model"
    TOOL = "tool"
    SESSION = "session"
    ROUTER = "router"
    SYSTEM = "system"


class EventValidationError(ValueError):
    """Raised when an event does not satisfy its registered specification."""


def _freeze(value: Any) -> Any:
    if isinstance(value, Mapping):
        return MappingProxyType({key: _freeze(item) for key, item in value.items()})
    if isinstance(value, (list, tuple)):
        return tuple(_freeze(item) for item in value)
    if isinstance(value, (set, frozenset)):
        return frozenset(_freeze(item) for item in value)
    return value


@dataclass(frozen=True, slots=True)
class EventEnvelope:
    """Immutable transport envelope.

    ``sequence`` is zero before publication. :class:`EventBus` replaces it with
    a strictly increasing session-wide sequence while retaining ``event_id``.
    """

    event_id: str
    kind: EventKind
    source: EventSource
    session_id: str
    task_id: str | None = None
    correlation_id: str | None = None
    sequence: int = 0
    payload: Mapping[str, Any] = field(default_factory=lambda: MappingProxyType({}))

    def __post_init__(self) -> None:
        if not self.event_id:
            raise EventValidationError("event_id must not be empty")
        if not self.session_id:
            raise EventValidationError("session_id must not be empty")
        if self.sequence < 0:
            raise EventValidationError("sequence must be non-negative")
        object.__setattr__(self, "payload", _freeze(self.payload))


EventValidator = Callable[[EventEnvelope], bool | None]


@dataclass(frozen=True, slots=True)
class EventSpec:
    """Validation rules for a single event kind."""

    kind: EventKind
    sources: frozenset[EventSource] | None = None
    required_payload: frozenset[str] = frozenset()
    validator: EventValidator | None = None

    def validate(self, event: EventEnvelope) -> None:
        if event.kind is not self.kind:
            raise EventValidationError(
                f"expected event kind {self.kind}, got {event.kind}"
            )
        if self.sources is not None and event.source not in self.sources:
            raise EventValidationError(
                f"source {event.source} is not valid for {event.kind}"
            )
        missing = self.required_payload.difference(event.payload)
        if missing:
            names = ", ".join(sorted(missing))
            raise EventValidationError(
                f"event {event.kind} is missing payload fields: {names}"
            )
        if self.validator is not None and self.validator(event) is False:
            raise EventValidationError(f"custom validation failed for {event.kind}")


def _spec(
    kind: EventKind,
    *sources: EventSource,
    required_payload: frozenset[str] = frozenset(),
) -> EventSpec:
    return EventSpec(
        kind,
        sources=frozenset(sources),
        required_payload=required_payload,
    )


# The default boundary prevents external/user events from impersonating model,
# tool, router, and lifecycle callbacks. Integrations may add stricter payload
# specs through EventFactory.register without changing the envelope protocol.
EVENT_SPECS: Mapping[EventKind, EventSpec] = MappingProxyType(
    {
        EventKind.INPUT_USER_MESSAGE: _spec(
            EventKind.INPUT_USER_MESSAGE,
            EventSource.USER,
            EventSource.CLI,
            required_payload=frozenset({"content"}),
        ),
        EventKind.INPUT_SLASH_COMMAND: _spec(
            EventKind.INPUT_SLASH_COMMAND,
            EventSource.USER,
            EventSource.CLI,
            required_payload=frozenset({"content"}),
        ),
        EventKind.INPUT_PENDING: _spec(
            EventKind.INPUT_PENDING, EventSource.SESSION
        ),
        EventKind.INPUT_HELD: _spec(EventKind.INPUT_HELD, EventSource.SESSION),
        EventKind.INPUT_CANCEL_REQUESTED: _spec(
            EventKind.INPUT_CANCEL_REQUESTED,
            EventSource.USER,
            EventSource.CLI,
            EventSource.SESSION,
        ),
        **{
            kind: _spec(kind, EventSource.SESSION)
            for kind in (
                EventKind.TASK_STARTED,
                EventKind.TASK_STATE_CHANGED,
                EventKind.TASK_COMPLETED,
                EventKind.TASK_FAILED,
                EventKind.TASK_CANCELLED,
                EventKind.SESSION_READY,
                EventKind.SESSION_STOPPED,
            )
        },
        **{
            kind: _spec(kind, EventSource.MODEL)
            for kind in (
                EventKind.MODEL_REQUEST_STARTED,
                EventKind.MODEL_TEXT_DELTA,
                EventKind.MODEL_REASONING_DELTA,
                EventKind.MODEL_TOOL_CALL_DELTA,
                EventKind.MODEL_RESPONSE_VALIDATING,
                EventKind.MODEL_RESPONSE_COMMITTED,
                EventKind.MODEL_RESPONSE_ABORTED,
                EventKind.MODEL_REQUEST_FAILED,
            )
        },
        EventKind.MODEL_SWITCHED: _spec(
            EventKind.MODEL_SWITCHED,
            EventSource.MODEL,
            EventSource.SESSION,
            EventSource.SYSTEM,
        ),
        EventKind.UI_MESSAGE: _spec(
            EventKind.UI_MESSAGE,
            EventSource.CLI,
            EventSource.SESSION,
            EventSource.SYSTEM,
            required_payload=frozenset({"text"}),
        ),
        **{
            kind: _spec(kind, EventSource.TOOL)
            for kind in (
                EventKind.TOOL_STARTED,
                EventKind.TOOL_OUTPUT_DELTA,
                EventKind.TOOL_FINISHED,
            )
        },
        EventKind.ROUTING_DECIDED: _spec(
            EventKind.ROUTING_DECIDED, EventSource.ROUTER
        ),
        EventKind.ROUTING_REJECTED: _spec(
            EventKind.ROUTING_REJECTED, EventSource.ROUTER
        ),
    }
)


class EventFactory:
    """Create validated envelopes without assigning publication order."""

    def __init__(self, specs: Mapping[EventKind, EventSpec] | None = None) -> None:
        self._specs = dict(EVENT_SPECS if specs is None else specs)
        self._lock = Lock()

    def register(self, spec: EventSpec) -> None:
        with self._lock:
            self._specs[spec.kind] = spec

    def create(
        self,
        kind: EventKind | str,
        *,
        source: EventSource | str,
        session_id: str,
        task_id: str | None = None,
        correlation_id: str | None = None,
        sequence: int = 0,
        payload: Mapping[str, Any] | None = None,
        event_id: str | None = None,
    ) -> EventEnvelope:
        try:
            event_kind = EventKind(kind)
            event_source = EventSource(source)
        except ValueError as error:
            raise EventValidationError(str(error)) from error
        event = EventEnvelope(
            event_id=event_id or uuid4().hex,
            kind=event_kind,
            source=event_source,
            session_id=session_id,
            task_id=task_id,
            correlation_id=correlation_id,
            sequence=sequence,
            payload=payload or {},
        )
        with self._lock:
            spec = self._specs.get(event_kind)
        if spec is not None:
            spec.validate(event)
        return event

    def validate(self, event: EventEnvelope) -> None:
        with self._lock:
            spec = self._specs.get(event.kind)
        if spec is not None:
            spec.validate(event)


_SENSITIVE_FIELDS = {
    "api_key",
    "apikey",
    "authorization",
    "token",
    "access_token",
    "refresh_token",
    "secret",
    "password",
}

_SENSITIVE_TEXT_PATTERNS = (
    re.compile(r"(?i)(authorization\s*:\s*bearer\s+)[^\s'\"]+"),
    re.compile(
        r"(?i)(\b(?:api[_-]?key|access[_-]?token|token|password|secret)"
        r"\s*[:=]\s*)[^\s'\"]+"
    ),
)


def _project_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        projected: dict[str, Any] = {}
        for key, item in value.items():
            normalized = str(key).lower().replace("-", "_")
            if normalized in _SENSITIVE_FIELDS or normalized.endswith("_secret"):
                projected[str(key)] = "[REDACTED]"
            else:
                projected[str(key)] = _project_value(item)
        return projected
    if isinstance(value, (tuple, list, set, frozenset)):
        return [_project_value(item) for item in value]
    if isinstance(value, str):
        projected = value
        for pattern in _SENSITIVE_TEXT_PATTERNS:
            projected = pattern.sub(r"\1[REDACTED]", projected)
        return projected
    return value


class EventProjector:
    """Produce JSON-friendly, recursively redacted audience projections."""

    AUDIENCES = frozenset({"terminal", "web", "log", "router"})

    def project(
        self, event: EventEnvelope, audience: str = "terminal"
    ) -> dict[str, Any]:
        if audience not in self.AUDIENCES:
            raise ValueError(f"unknown event audience: {audience}")
        payload = _project_value(event.payload)
        if audience == "terminal" and event.kind is EventKind.MODEL_REASONING_DELTA:
            payload = {key: "[HIDDEN]" for key in payload}
        return {
            "event_id": event.event_id,
            "kind": event.kind.value,
            "source": event.source.value,
            "session_id": event.session_id,
            "task_id": event.task_id,
            "correlation_id": event.correlation_id,
            "sequence": event.sequence,
            "payload": payload,
        }


class EventBus:
    """A FIFO bus that assigns one strict sequence across all publishers."""

    def __init__(
        self,
        factory: EventFactory | None = None,
        *,
        max_buffered_events: int = 4_096,
    ) -> None:
        if max_buffered_events <= 0:
            raise ValueError("max_buffered_events must be positive")
        self.factory = factory or EventFactory()
        self._events: Queue[EventEnvelope] = Queue(maxsize=max_buffered_events)
        self._fanout: Queue[EventEnvelope | None] = Queue()
        self._publish_lock = Lock()
        self._subscriber_lock = Lock()
        self._subscribers: dict[int, Callable[[EventEnvelope], None]] = {}
        self._subscriber_id = 0
        self._sequence = 0
        self._closed = False
        self._dispatcher = Thread(
            target=self._dispatch_loop,
            name="laohuang-event-fanout",
            daemon=True,
        )
        self._dispatcher.start()

    @property
    def last_sequence(self) -> int:
        with self._publish_lock:
            return self._sequence

    def publish(
        self,
        kind: EventKind | str,
        *,
        source: EventSource | str,
        session_id: str,
        task_id: str | None = None,
        correlation_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> EventEnvelope:
        event = self.factory.create(
            kind,
            source=source,
            session_id=session_id,
            task_id=task_id,
            correlation_id=correlation_id,
            payload=payload,
        )
        return self.publish_event(event)

    def publish_event(self, event: EventEnvelope) -> EventEnvelope:
        self.factory.validate(event)
        with self._publish_lock:
            if self._closed:
                raise RuntimeError("event bus is closed")
            self._sequence += 1
            published = replace(event, sequence=self._sequence)
            try:
                self._events.put_nowait(published)
            except Full:
                # Fan-out retains every event independently. The pull buffer
                # is bounded so an unused diagnostic queue cannot grow forever
                # during long Bash/model streams.
                try:
                    self._events.get_nowait()
                except Empty:
                    pass
                self._events.put_nowait(published)
            self._fanout.put_nowait(published)
        return published

    def _dispatch_loop(self) -> None:
        while True:
            event = self._fanout.get()
            try:
                if event is None:
                    return
                with self._subscriber_lock:
                    subscribers = tuple(self._subscribers.values())
                for subscriber in subscribers:
                    try:
                        subscriber(event)
                    except Exception:
                        # A broken projection must not stop later consumers.
                        continue
            finally:
                self._fanout.task_done()

    def flush(self) -> None:
        """Wait until every published event reached current subscribers."""

        self._fanout.join()

    def close(self) -> None:
        """Deliver queued events and stop the dispatcher thread exactly once."""

        with self._publish_lock:
            if self._closed:
                return
            self._closed = True
            self._fanout.put_nowait(None)
        self._fanout.join()
        if self._dispatcher is not current_thread():
            self._dispatcher.join(timeout=2)

    def subscribe(
        self, callback: Callable[[EventEnvelope], None]
    ) -> Callable[[], None]:
        """Fan out every future event and return an unsubscribe callback."""

        with self._publish_lock:
            if self._closed:
                raise RuntimeError("event bus is closed")
        with self._subscriber_lock:
            self._subscriber_id += 1
            subscriber_id = self._subscriber_id
            self._subscribers[subscriber_id] = callback

        def unsubscribe() -> None:
            with self._subscriber_lock:
                self._subscribers.pop(subscriber_id, None)

        return unsubscribe

    def get(self, timeout: float | None = None) -> EventEnvelope:
        return self._events.get(timeout=timeout)

    def get_nowait(self) -> EventEnvelope:
        return self._events.get_nowait()

    def drain(self, limit: int | None = None) -> tuple[EventEnvelope, ...]:
        events: list[EventEnvelope] = []
        while limit is None or len(events) < limit:
            try:
                events.append(self._events.get_nowait())
            except Empty:
                break
        return tuple(events)

    def qsize(self) -> int:
        return self._events.qsize()
