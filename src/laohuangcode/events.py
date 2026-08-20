"""Canonical events and the thread-safe event bus used by the runtime."""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from enum import StrEnum
import json
from queue import Empty, Full, Queue
import re
from threading import Condition, Lock, Thread, current_thread
from time import monotonic
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
    MODEL_RESPONSE_SUMMARY = "model.response_summary"
    MODEL_SWITCHED = "model.switched"

    AGENT_GUARD_TRIGGERED = "agent.guard_triggered"
    AGENT_GUARD_FAILED = "agent.guard_failed"

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
    payload_types: Mapping[str, type | tuple[type, ...]] = field(
        default_factory=lambda: MappingProxyType({})
    )
    require_task_id: bool = False
    require_correlation_id: bool = False
    max_payload_chars: int = 1_000_000
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
        if self.require_task_id and not event.task_id:
            raise EventValidationError(f"event {event.kind} requires task_id")
        if self.require_correlation_id and not event.correlation_id:
            raise EventValidationError(
                f"event {event.kind} requires correlation_id"
            )
        missing = self.required_payload.difference(event.payload)
        if missing:
            names = ", ".join(sorted(missing))
            raise EventValidationError(
                f"event {event.kind} is missing payload fields: {names}"
            )
        for name, expected in self.payload_types.items():
            if name in event.payload and not isinstance(event.payload[name], expected):
                raise EventValidationError(
                    f"event {event.kind} payload field {name!r} has invalid type"
                )
        try:
            payload_size = len(
                json.dumps(
                    _thaw(event.payload),
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
            )
        except (TypeError, ValueError, RecursionError) as error:
            raise EventValidationError(
                f"event {event.kind} payload must be JSON-compatible"
            ) from error
        if payload_size > self.max_payload_chars:
            raise EventValidationError(
                f"event {event.kind} payload exceeds {self.max_payload_chars} characters"
            )
        if self.validator is not None and self.validator(event) is False:
            raise EventValidationError(f"custom validation failed for {event.kind}")


def _spec(
    kind: EventKind,
    *sources: EventSource,
    required_payload: frozenset[str] = frozenset(),
    payload_types: Mapping[str, type | tuple[type, ...]] | None = None,
    require_task_id: bool = False,
    require_correlation_id: bool = False,
    max_payload_chars: int = 1_000_000,
) -> EventSpec:
    return EventSpec(
        kind,
        sources=frozenset(sources),
        required_payload=required_payload,
        payload_types=MappingProxyType(dict(payload_types or {})),
        require_task_id=require_task_id,
        require_correlation_id=require_correlation_id,
        max_payload_chars=max_payload_chars,
    )


def _thaw(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _thaw(item) for key, item in value.items()}
    if isinstance(value, (tuple, list, set, frozenset)):
        return [_thaw(item) for item in value]
    return value


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
            payload_types={"content": str, "strategy": str},
            max_payload_chars=100_000,
        ),
        EventKind.INPUT_SLASH_COMMAND: _spec(
            EventKind.INPUT_SLASH_COMMAND,
            EventSource.USER,
            EventSource.CLI,
            required_payload=frozenset({"content"}),
            payload_types={"content": str},
            max_payload_chars=16_384,
        ),
        EventKind.INPUT_PENDING: _spec(
            EventKind.INPUT_PENDING,
            EventSource.SESSION,
            required_payload=frozenset({"pending_count"}),
            payload_types={"pending_count": int},
            require_task_id=True,
            require_correlation_id=True,
        ),
        EventKind.INPUT_HELD: _spec(
            EventKind.INPUT_HELD,
            EventSource.SESSION,
            required_payload=frozenset({"held_count"}),
            payload_types={"held_count": int},
            require_task_id=True,
            require_correlation_id=True,
        ),
        EventKind.INPUT_CANCEL_REQUESTED: _spec(
            EventKind.INPUT_CANCEL_REQUESTED,
            EventSource.USER,
            EventSource.CLI,
            EventSource.SESSION,
        ),
        **{
            kind: _spec(kind, EventSource.SESSION, require_task_id=True)
            for kind in (
                EventKind.TASK_STARTED,
                EventKind.TASK_STATE_CHANGED,
                EventKind.TASK_COMPLETED,
                EventKind.TASK_FAILED,
                EventKind.TASK_CANCELLED,
            )
        },
        EventKind.TASK_STATE_CHANGED: _spec(
            EventKind.TASK_STATE_CHANGED,
            EventSource.SESSION,
            required_payload=frozenset({"state"}),
            payload_types={"state": str},
            require_task_id=True,
        ),
        EventKind.SESSION_READY: _spec(
            EventKind.SESSION_READY, EventSource.SESSION
        ),
        EventKind.SESSION_STOPPED: _spec(
            EventKind.SESSION_STOPPED, EventSource.SESSION
        ),
        **{
            kind: _spec(
                kind,
                EventSource.MODEL,
                require_task_id=True,
                require_correlation_id=True,
                max_payload_chars=(16_384 if "delta" in kind.value else 100_000),
            )
            for kind in (
                EventKind.MODEL_REQUEST_STARTED,
                EventKind.MODEL_TEXT_DELTA,
                EventKind.MODEL_REASONING_DELTA,
                EventKind.MODEL_TOOL_CALL_DELTA,
                EventKind.MODEL_RESPONSE_VALIDATING,
                EventKind.MODEL_RESPONSE_COMMITTED,
                EventKind.MODEL_RESPONSE_ABORTED,
                EventKind.MODEL_REQUEST_FAILED,
                EventKind.MODEL_RESPONSE_SUMMARY,
            )
        },
        EventKind.MODEL_REQUEST_STARTED: _spec(
            EventKind.MODEL_REQUEST_STARTED,
            EventSource.MODEL,
            required_payload=frozenset({"request_id"}),
            payload_types={"request_id": str},
            require_task_id=True,
            require_correlation_id=True,
            max_payload_chars=100_000,
        ),
        EventKind.MODEL_TEXT_DELTA: _spec(
            EventKind.MODEL_TEXT_DELTA,
            EventSource.MODEL,
            required_payload=frozenset({"text"}),
            payload_types={"text": str, "request_id": str},
            require_task_id=True,
            require_correlation_id=True,
            max_payload_chars=16_384,
        ),
        EventKind.MODEL_REASONING_DELTA: _spec(
            EventKind.MODEL_REASONING_DELTA,
            EventSource.MODEL,
            required_payload=frozenset({"text"}),
            payload_types={"text": str, "request_id": str},
            require_task_id=True,
            require_correlation_id=True,
            max_payload_chars=16_384,
        ),
        EventKind.MODEL_TOOL_CALL_DELTA: _spec(
            EventKind.MODEL_TOOL_CALL_DELTA,
            EventSource.MODEL,
            required_payload=frozenset({"index"}),
            payload_types={"index": int, "request_id": str},
            require_task_id=True,
            require_correlation_id=True,
            max_payload_chars=16_384,
        ),
        EventKind.MODEL_SWITCHED: _spec(
            EventKind.MODEL_SWITCHED,
            EventSource.MODEL,
            EventSource.SESSION,
            EventSource.SYSTEM,
        ),
        **{
            kind: _spec(
                kind,
                EventSource.SYSTEM,
                required_payload=frozenset({"reason"}),
                payload_types={
                    "reason": str,
                    "tool_rounds": int,
                    "model_requests": int,
                    "total_tokens": int,
                    "elapsed_ms": int,
                },
                require_task_id=True,
                max_payload_chars=100_000,
            )
            for kind in (
                EventKind.AGENT_GUARD_TRIGGERED,
                EventKind.AGENT_GUARD_FAILED,
            )
        },
        EventKind.UI_MESSAGE: _spec(
            EventKind.UI_MESSAGE,
            EventSource.CLI,
            EventSource.SESSION,
            EventSource.SYSTEM,
            required_payload=frozenset({"text"}),
            payload_types={"text": str, "style": str},
            max_payload_chars=100_000,
        ),
        **{
            kind: _spec(
                kind,
                EventSource.TOOL,
                require_task_id=True,
                require_correlation_id=True,
                max_payload_chars=100_000,
            )
            for kind in (
                EventKind.TOOL_STARTED,
                EventKind.TOOL_OUTPUT_DELTA,
                EventKind.TOOL_FINISHED,
            )
        },
        EventKind.TOOL_STARTED: _spec(
            EventKind.TOOL_STARTED,
            EventSource.TOOL,
            required_payload=frozenset({"name", "arguments"}),
            payload_types={"name": str, "arguments": Mapping},
            require_task_id=True,
            require_correlation_id=True,
            max_payload_chars=100_000,
        ),
        EventKind.TOOL_OUTPUT_DELTA: _spec(
            EventKind.TOOL_OUTPUT_DELTA,
            EventSource.TOOL,
            required_payload=frozenset({"stream", "text"}),
            payload_types={"stream": str, "text": str},
            require_task_id=True,
            require_correlation_id=True,
            max_payload_chars=16_384,
        ),
        EventKind.TOOL_FINISHED: _spec(
            EventKind.TOOL_FINISHED,
            EventSource.TOOL,
            required_payload=frozenset({"status"}),
            payload_types={"status": str},
            require_task_id=True,
            require_correlation_id=True,
            max_payload_chars=100_000,
        ),
        EventKind.ROUTING_DECIDED: _spec(
            EventKind.ROUTING_DECIDED,
            EventSource.ROUTER,
            required_payload=frozenset({"destination", "reason"}),
            payload_types={"destination": str, "reason": str},
            require_correlation_id=True,
        ),
        EventKind.ROUTING_REJECTED: _spec(
            EventKind.ROUTING_REJECTED,
            EventSource.ROUTER,
            required_payload=frozenset({"reason"}),
            payload_types={"reason": str},
            require_correlation_id=True,
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


_COALESCIBLE_EVENTS = {
    EventKind.MODEL_TEXT_DELTA,
    EventKind.MODEL_REASONING_DELTA,
    EventKind.MODEL_TOOL_CALL_DELTA,
    EventKind.TOOL_OUTPUT_DELTA,
}
_MAX_COALESCED_TEXT_CHARS = 65_536


class _SubscriberMailbox:
    """One bounded worker queue per subscriber.

    A slow terminal or web projection can no longer stall another subscriber.
    Under pressure only adjacent compatible deltas are combined; lifecycle and
    control events are never discarded.
    """

    def __init__(
        self,
        callback: Callable[[EventEnvelope], None],
        *,
        max_items: int,
        name: str,
    ) -> None:
        self.callback = callback
        self.max_items = max_items
        self._items: deque[EventEnvelope] = deque()
        self._condition = Condition()
        self._unfinished = 0
        self._dropped = 0
        self._pending_gap = 0
        self._closed = False
        self._worker = Thread(target=self._run, name=name, daemon=True)
        self._worker.start()

    @staticmethod
    def _merge(left: EventEnvelope, right: EventEnvelope) -> EventEnvelope | None:
        if (
            left.kind is not right.kind
            or left.task_id != right.task_id
            or left.correlation_id != right.correlation_id
            or left.kind not in _COALESCIBLE_EVENTS
        ):
            return None
        left_text = left.payload.get("text")
        right_text = right.payload.get("text")
        if not isinstance(left_text, str) or not isinstance(right_text, str):
            return None
        if len(left_text) + len(right_text) > _MAX_COALESCED_TEXT_CHARS:
            return None
        payload = dict(right.payload)
        payload["text"] = left_text + right_text
        inherited_gap = int(left.payload.get("_projection_dropped", 0) or 0)
        if inherited_gap:
            payload["_projection_dropped"] = (
                int(payload.get("_projection_dropped", 0) or 0) + inherited_gap
            )
        payload["coalesced_from_sequence"] = left.payload.get(
            "coalesced_from_sequence", left.sequence
        )
        return replace(right, payload=_freeze(payload))

    def enqueue(self, event: EventEnvelope) -> bool:
        with self._condition:
            if self._closed:
                return False
            if self._items:
                merged = self._merge(self._items[-1], event)
                if merged is not None and len(self._items) >= self.max_items - 64:
                    self._items[-1] = self._with_gap_marker(merged)
                    return True
            if (
                event.kind in _COALESCIBLE_EVENTS
                and len(self._items) >= self.max_items - 64
            ):
                self._record_drop()
                return False
            if len(self._items) >= self.max_items:
                # Preserve control/lifecycle events by evicting an older
                # display-only delta. If a subscriber cannot consume even the
                # reserved critical capacity, detach at this projection
                # boundary instead of blocking the runtime and cancellation.
                dropped_index = next(
                    (
                        index
                        for index, queued in enumerate(self._items)
                        if queued.kind in _COALESCIBLE_EVENTS
                    ),
                    None,
                )
                if dropped_index is None:
                    dropped_index = 0
                dropped_event = self._items[dropped_index]
                del self._items[dropped_index]
                self._unfinished -= 1
                inherited_gap = int(
                    dropped_event.payload.get("_projection_dropped", 0) or 0
                )
                self._record_drop(1 + inherited_gap)
            self._items.append(self._with_gap_marker(event))
            self._unfinished += 1
            self._condition.notify_all()
            return True

    def _record_drop(self, count: int = 1) -> None:
        self._dropped += count
        self._pending_gap += count

    def _with_gap_marker(self, event: EventEnvelope) -> EventEnvelope:
        if not self._pending_gap:
            return event
        payload = dict(event.payload)
        existing_gap = int(payload.get("_projection_dropped", 0) or 0)
        payload["_projection_dropped"] = existing_gap + self._pending_gap
        self._pending_gap = 0
        return replace(event, payload=_freeze(payload))

    def flush(self, timeout: float | None = None) -> bool:
        deadline = None if timeout is None else monotonic() + timeout
        with self._condition:
            while self._unfinished:
                if deadline is None:
                    self._condition.wait()
                    continue
                remaining = deadline - monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(remaining)
            return True

    def close(self) -> None:
        if self._worker is current_thread():
            with self._condition:
                self._closed = True
                self._condition.notify_all()
            return
        drained = self.flush(timeout=2.0)
        with self._condition:
            self._closed = True
            if not drained:
                queued = len(self._items)
                self._items.clear()
                self._unfinished -= queued
                self._record_drop(queued)
            self._condition.notify_all()
        self._worker.join(timeout=2)

    def _run(self) -> None:
        while True:
            with self._condition:
                while not self._items and not self._closed:
                    self._condition.wait()
                if not self._items and self._closed:
                    return
                event = self._items.popleft()
                self._condition.notify_all()
            try:
                self.callback(event)
            except Exception:
                # A broken projection is isolated to its own mailbox.
                pass
            finally:
                with self._condition:
                    self._unfinished -= 1
                    self._condition.notify_all()


class EventBus:
    """A FIFO bus that assigns one strict sequence across all publishers."""

    def __init__(
        self,
        factory: EventFactory | None = None,
        *,
        max_buffered_events: int = 4_096,
        subscriber_mailbox_size: int = 4_096,
    ) -> None:
        if max_buffered_events <= 0:
            raise ValueError("max_buffered_events must be positive")
        self.factory = factory or EventFactory()
        self._events: Queue[EventEnvelope] = Queue(maxsize=max_buffered_events)
        if subscriber_mailbox_size <= 64:
            raise ValueError("subscriber_mailbox_size must be greater than 64")
        self._subscriber_mailbox_size = subscriber_mailbox_size
        self._publish_lock = Lock()
        self._subscriber_lock = Lock()
        self._subscribers: dict[int, _SubscriberMailbox] = {}
        self._subscriber_id = 0
        self._sequence = 0
        self._closed = False

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
                # Subscriber mailboxes retain/coalesce independently. The
                # pull buffer is bounded so an unused diagnostic queue cannot
                # grow forever during long Bash/model streams.
                try:
                    self._events.get_nowait()
                except Empty:
                    pass
                self._events.put_nowait(published)
            with self._subscriber_lock:
                mailboxes = tuple(self._subscribers.values())
            for mailbox in mailboxes:
                mailbox.enqueue(published)
        return published

    def flush(self) -> None:
        """Wait until every published event reached current subscribers."""

        while True:
            before = self.last_sequence
            with self._subscriber_lock:
                mailboxes = tuple(self._subscribers.values())
            for mailbox in mailboxes:
                mailbox.flush()
            if self.last_sequence == before:
                return

    def close(self) -> None:
        """Deliver queued events and stop subscriber workers exactly once."""

        with self._publish_lock:
            if self._closed:
                return
            self._closed = True
        with self._subscriber_lock:
            mailboxes = tuple(self._subscribers.values())
            self._subscribers.clear()
        for mailbox in mailboxes:
            mailbox.close()

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
                mailbox = _SubscriberMailbox(
                    callback,
                    max_items=self._subscriber_mailbox_size,
                    name=f"laohuang-event-subscriber-{subscriber_id}",
                )
                self._subscribers[subscriber_id] = mailbox

        def unsubscribe() -> None:
            with self._subscriber_lock:
                removed = self._subscribers.pop(subscriber_id, None)
            if removed is not None:
                removed.close()

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
