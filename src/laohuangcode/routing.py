"""Deterministic routing, task registry, and runtime input queues."""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace
from enum import StrEnum
from threading import Lock

from .cancellation import CancelToken
from .events import EventEnvelope, EventKind, EventSource


class TaskState(StrEnum):
    RUNNING_MODEL = "running_model"
    RUNNING_TOOLS = "running_tools"
    CANCELLING = "cancelling"
    CANCELLED = "cancelled"
    COMPLETED = "completed"
    FAILED = "failed"


_TERMINAL_TASK_STATES = {
    TaskState.CANCELLED,
    TaskState.COMPLETED,
    TaskState.FAILED,
}

_ALLOWED_TASK_TRANSITIONS = {
    TaskState.RUNNING_MODEL: {
        TaskState.RUNNING_TOOLS,
        TaskState.CANCELLING,
        TaskState.COMPLETED,
        TaskState.FAILED,
    },
    TaskState.RUNNING_TOOLS: {
        TaskState.RUNNING_MODEL,
        TaskState.CANCELLING,
        TaskState.COMPLETED,
        TaskState.FAILED,
    },
    TaskState.CANCELLING: {TaskState.CANCELLED},
    TaskState.CANCELLED: set(),
    TaskState.COMPLETED: set(),
    TaskState.FAILED: set(),
}


@dataclass(slots=True)
class TaskRecord:
    task_id: str
    state: TaskState
    cancel_token: CancelToken
    result: str | None = None
    error: str | None = None


class TaskRegistry:
    """Thread-safe task records with at most one active task."""

    def __init__(self) -> None:
        self._tasks: dict[str, TaskRecord] = {}
        self._active_task_id: str | None = None
        self._lock = Lock()

    @property
    def active_task_id(self) -> str | None:
        with self._lock:
            return self._active_task_id

    def register(
        self,
        task_id: str,
        *,
        state: TaskState = TaskState.RUNNING_MODEL,
        cancel_token: CancelToken | None = None,
        activate: bool = True,
    ) -> TaskRecord:
        with self._lock:
            if task_id in self._tasks:
                raise ValueError(f"task already exists: {task_id}")
            if activate and self._active_task_id is not None:
                raise RuntimeError("another task is already active")
            record = TaskRecord(task_id, state, cancel_token or CancelToken())
            self._tasks[task_id] = record
            if activate and state not in _TERMINAL_TASK_STATES:
                self._active_task_id = task_id
            return replace(record)

    def get(self, task_id: str) -> TaskRecord | None:
        with self._lock:
            record = self._tasks.get(task_id)
            return replace(record) if record is not None else None

    def active(self) -> TaskRecord | None:
        with self._lock:
            if self._active_task_id is None:
                return None
            return replace(self._tasks[self._active_task_id])

    def transition(
        self,
        task_id: str,
        state: TaskState,
        *,
        result: str | None = None,
        error: str | None = None,
    ) -> TaskRecord:
        with self._lock:
            record = self._tasks.get(task_id)
            if record is None:
                raise KeyError(task_id)
            if state is not record.state and state not in _ALLOWED_TASK_TRANSITIONS[
                record.state
            ]:
                raise RuntimeError(
                    f"invalid task transition: {record.state.value} -> {state.value}"
                )
            record.state = state
            if result is not None:
                record.result = result
            if error is not None:
                record.error = error
            if state in _TERMINAL_TASK_STATES and self._active_task_id == task_id:
                self._active_task_id = None
            elif state not in _TERMINAL_TASK_STATES:
                active = self._active_task_id
                if active is not None and active != task_id:
                    raise RuntimeError("another task is already active")
                self._active_task_id = task_id
            return replace(record)

    def records(self) -> tuple[TaskRecord, ...]:
        with self._lock:
            return tuple(replace(record) for record in self._tasks.values())


class RouteDestination(StrEnum):
    NEW_TASK = "new_task"
    CURRENT_TASK = "current_task"
    PENDING = "pending"
    HELD = "held"
    CONTROL = "control"
    DROP = "drop"


class RouteTiming(StrEnum):
    IMMEDIATE = "immediate"
    SAFE_POINT = "safe_point"
    AFTER_CANCEL = "after_cancel"


class RouteStrategy(StrEnum):
    EXECUTE = "execute"
    STEER = "steer"
    FOLLOW_UP = "follow_up"
    CANCEL = "cancel"
    REJECT = "reject"


@dataclass(frozen=True, slots=True)
class RouteDecision:
    task_id: str | None
    destination: RouteDestination
    timing: RouteTiming
    strategy: RouteStrategy
    confidence: float
    reason: str
    layer: int


@dataclass(frozen=True, slots=True)
class RoutedEvent:
    event: EventEnvelope
    decision: RouteDecision


def estimate_tokens(text: str) -> int:
    """Provider-neutral conservative token estimate without a tokenizer."""

    if not text:
        return 0
    return max(1, (len(text.encode("utf-8")) + 3) // 4)


def _event_tokens(routed: RoutedEvent) -> int:
    return estimate_tokens(str(routed.event.payload.get("content", "")))


@dataclass(frozen=True, slots=True)
class DeadLetter:
    event: EventEnvelope
    reason: str


class DeadLetterQueue:
    """Bounded inspection queue for events rejected by routing or capacity."""

    def __init__(self, max_items: int = 100) -> None:
        if max_items <= 0:
            raise ValueError("max_items must be positive")
        self.max_items = max_items
        self._items: deque[DeadLetter] = deque()
        self._lock = Lock()

    def put(self, event: EventEnvelope, reason: str) -> None:
        with self._lock:
            if len(self._items) >= self.max_items:
                self._items.popleft()
            self._items.append(DeadLetter(event, reason))

    def drain(self) -> tuple[DeadLetter, ...]:
        with self._lock:
            items = tuple(self._items)
            self._items.clear()
            return items

    def snapshot(self) -> tuple[DeadLetter, ...]:
        with self._lock:
            return tuple(self._items)

    def clear(self) -> int:
        return len(self.drain())

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)


SemanticClassifier = Callable[
    [EventEnvelope, TaskRecord | None], RouteStrategy | str | RouteDecision | None
]
SafetyPolicy = Callable[
    [EventEnvelope, RouteDecision], RouteDecision | bool | None
]


class EventRouter:
    """Four-layer router with deterministic safety as the final arbiter.

    Layers one through three short-circuit after obtaining a decision. Layer
    four always runs, so an injected semantic classifier can never override
    cancellation, invalid task ownership, or a custom safety policy.
    """

    def __init__(
        self,
        task_registry: TaskRegistry,
        *,
        semantic_classifier: SemanticClassifier | None = None,
        safety_policy: SafetyPolicy | None = None,
    ) -> None:
        self.task_registry = task_registry
        self.semantic_classifier = semantic_classifier
        self.safety_policy = safety_policy

    def route(self, event: EventEnvelope) -> RoutedEvent:
        active = self.task_registry.active()
        decision = self._metadata_match(event, active)
        if decision is None:
            decision = self._deterministic_rules(event, active)
        if decision is None:
            decision = self._semantic_classification(event, active)
        if decision is None:
            decision = self._default_decision(event, active)
        decision = self._safety_arbiter(event, active, decision)
        return RoutedEvent(event, decision)

    def _metadata_match(
        self, event: EventEnvelope, active: TaskRecord | None
    ) -> RouteDecision | None:
        if event.task_id is None:
            return None
        target = self.task_registry.get(event.task_id)
        if target is None:
            return RouteDecision(
                event.task_id,
                RouteDestination.DROP,
                RouteTiming.IMMEDIATE,
                RouteStrategy.REJECT,
                1.0,
                "metadata references an unknown task",
                1,
            )
        if event.source not in {EventSource.USER, EventSource.CLI}:
            if (
                active is None
                or target.task_id != active.task_id
                or target.state in _TERMINAL_TASK_STATES
            ):
                return RouteDecision(
                    target.task_id,
                    RouteDestination.DROP,
                    RouteTiming.IMMEDIATE,
                    RouteStrategy.REJECT,
                    1.0,
                    "stale internal callback targeted an inactive task",
                    1,
                )
            return RouteDecision(
                target.task_id,
                RouteDestination.CURRENT_TASK,
                RouteTiming.IMMEDIATE,
                RouteStrategy.EXECUTE,
                1.0,
                "internal callback matched task metadata",
                1,
            )
        if active is not None and target.task_id == active.task_id:
            destination = (
                RouteDestination.HELD
                if active.state is TaskState.CANCELLING
                else RouteDestination.PENDING
            )
            timing = (
                RouteTiming.AFTER_CANCEL
                if destination is RouteDestination.HELD
                else RouteTiming.SAFE_POINT
            )
            return RouteDecision(
                target.task_id,
                destination,
                timing,
                RouteStrategy.STEER,
                1.0,
                "user input explicitly matched the active task",
                1,
            )
        return RouteDecision(
            target.task_id,
            RouteDestination.HELD,
            RouteTiming.AFTER_CANCEL,
            RouteStrategy.FOLLOW_UP,
            1.0,
            "user input targets an inactive task",
            1,
        )

    def _deterministic_rules(
        self, event: EventEnvelope, active: TaskRecord | None
    ) -> RouteDecision | None:
        content = str(event.payload.get("content", "")).strip()
        if event.kind is EventKind.INPUT_CANCEL_REQUESTED or content == "/cancel":
            return RouteDecision(
                active.task_id if active else None,
                RouteDestination.CONTROL,
                RouteTiming.IMMEDIATE,
                RouteStrategy.CANCEL,
                1.0,
                "cancel is an immediate control event",
                2,
            )
        if event.kind is EventKind.INPUT_SLASH_COMMAND:
            return RouteDecision(
                active.task_id if active else None,
                RouteDestination.CONTROL,
                RouteTiming.IMMEDIATE,
                RouteStrategy.EXECUTE,
                1.0,
                "slash commands are deterministic local control input",
                2,
            )
        if event.kind is not EventKind.INPUT_RECEIVED:
            return RouteDecision(
                event.task_id or (active.task_id if active else None),
                RouteDestination.CURRENT_TASK,
                RouteTiming.IMMEDIATE,
                RouteStrategy.EXECUTE,
                1.0,
                "non-input event follows deterministic callback routing",
                2,
            )
        if active is None:
            return RouteDecision(
                None,
                RouteDestination.NEW_TASK,
                RouteTiming.IMMEDIATE,
                RouteStrategy.EXECUTE,
                1.0,
                "no active task",
                2,
            )
        if active.state is TaskState.CANCELLING:
            return RouteDecision(
                active.task_id,
                RouteDestination.HELD,
                RouteTiming.AFTER_CANCEL,
                RouteStrategy.FOLLOW_UP,
                1.0,
                "ordinary input is held while cancellation settles",
                2,
            )
        requested = event.payload.get("strategy")
        if requested in {RouteStrategy.STEER, RouteStrategy.STEER.value}:
            return RouteDecision(
                active.task_id,
                RouteDestination.PENDING,
                RouteTiming.SAFE_POINT,
                RouteStrategy.STEER,
                1.0,
                "explicit steering strategy",
                2,
            )
        if requested in {RouteStrategy.FOLLOW_UP, RouteStrategy.FOLLOW_UP.value}:
            return RouteDecision(
                active.task_id,
                RouteDestination.PENDING,
                RouteTiming.SAFE_POINT,
                RouteStrategy.FOLLOW_UP,
                1.0,
                "explicit follow-up strategy",
                2,
            )
        return None

    def _semantic_classification(
        self, event: EventEnvelope, active: TaskRecord | None
    ) -> RouteDecision | None:
        if self.semantic_classifier is None or active is None:
            return None
        classified = self.semantic_classifier(event, active)
        if isinstance(classified, RouteDecision):
            return classified
        if classified is None:
            return None
        try:
            strategy = RouteStrategy(classified)
        except ValueError:
            return None
        if strategy not in {RouteStrategy.STEER, RouteStrategy.FOLLOW_UP}:
            return None
        return RouteDecision(
            active.task_id,
            RouteDestination.PENDING,
            RouteTiming.SAFE_POINT,
            strategy,
            0.75,
            "semantic classifier resolved ambiguous input",
            3,
        )

    @staticmethod
    def _default_decision(
        event: EventEnvelope, active: TaskRecord | None
    ) -> RouteDecision:
        if active is None:
            return RouteDecision(
                None,
                RouteDestination.NEW_TASK,
                RouteTiming.IMMEDIATE,
                RouteStrategy.EXECUTE,
                0.5,
                "defaulted to a new task",
                3,
            )
        return RouteDecision(
            active.task_id,
            RouteDestination.PENDING,
            RouteTiming.SAFE_POINT,
            RouteStrategy.FOLLOW_UP,
            0.5,
            "ambiguous input defaults to a safe follow-up",
            3,
        )

    def _safety_arbiter(
        self,
        event: EventEnvelope,
        active: TaskRecord | None,
        decision: RouteDecision,
    ) -> RouteDecision:
        if self.safety_policy is not None:
            verdict = self.safety_policy(event, decision)
            if isinstance(verdict, RouteDecision):
                decision = verdict
            elif verdict is False:
                decision = RouteDecision(
                    decision.task_id,
                    RouteDestination.DROP,
                    RouteTiming.IMMEDIATE,
                    RouteStrategy.REJECT,
                    1.0,
                    "custom safety policy rejected the event",
                    4,
                )

        # These invariants run after the custom policy, so neither a classifier
        # nor a policy callback can downgrade cancellation or target an unknown
        # task.
        if event.kind is EventKind.INPUT_CANCEL_REQUESTED:
            decision = RouteDecision(
                active.task_id if active else None,
                RouteDestination.CONTROL,
                RouteTiming.IMMEDIATE,
                RouteStrategy.CANCEL,
                1.0,
                "safety arbiter preserves immediate cancellation",
                4,
            )
        elif (
            decision.task_id is not None
            and self.task_registry.get(decision.task_id) is None
            and decision.destination is not RouteDestination.NEW_TASK
        ):
            decision = RouteDecision(
                decision.task_id,
                RouteDestination.DROP,
                RouteTiming.IMMEDIATE,
                RouteStrategy.REJECT,
                1.0,
                "safety arbiter rejected an unknown task",
                4,
            )
        return decision


def _compatibility_key(routed: RoutedEvent) -> tuple[str, str | None, str, str]:
    decision = routed.decision
    return (
        routed.event.session_id,
        decision.task_id,
        decision.strategy.value,
        decision.timing.value,
    )


class PendingQueue:
    """FIFO queue with atomic compatible-batch snapshots."""

    def __init__(
        self, max_items: int = 100, *, max_estimated_tokens: int = 8_000
    ) -> None:
        if max_items <= 0:
            raise ValueError("max_items must be positive")
        if max_estimated_tokens <= 0:
            raise ValueError("max_estimated_tokens must be positive")
        self._items: deque[RoutedEvent] = deque()
        self.max_items = max_items
        self.max_estimated_tokens = max_estimated_tokens
        self._estimated_tokens = 0
        self._lock = Lock()

    def put(self, event: RoutedEvent) -> None:
        if event.decision.destination is not RouteDestination.PENDING:
            raise ValueError("PendingQueue only accepts pending events")
        with self._lock:
            if len(self._items) >= self.max_items:
                raise OverflowError("pending queue is full")
            event_tokens = _event_tokens(event)
            if self._estimated_tokens + event_tokens > self.max_estimated_tokens:
                raise OverflowError("pending queue token budget is full")
            self._items.append(event)
            self._estimated_tokens += event_tokens

    def drain_compatible(
        self,
        *,
        task_id: str | None = None,
        strategy: RouteStrategy | None = None,
        timing: RouteTiming | None = None,
    ) -> tuple[RoutedEvent, ...]:
        """Atomically remove all currently eligible events in source order."""

        with self._lock:
            if not self._items:
                return ()
            pivot = next(
                (
                    item
                    for item in self._items
                    if task_id is None or item.decision.task_id == task_id
                ),
                None,
            )
            if pivot is None:
                return ()
            key = _compatibility_key(pivot)
            if strategy is not None:
                key = (key[0], key[1], strategy.value, key[3])
            if timing is not None:
                key = (key[0], key[1], key[2], timing.value)
            drained: list[RoutedEvent] = []
            retained: deque[RoutedEvent] = deque()
            while self._items:
                item = self._items.popleft()
                if _compatibility_key(item) == key:
                    drained.append(item)
                else:
                    retained.append(item)
            self._items = retained
            self._estimated_tokens = sum(_event_tokens(item) for item in retained)
            return tuple(drained)

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)

    def drain_task(self, task_id: str) -> tuple[RoutedEvent, ...]:
        """Atomically remove every strategy bucket belonging to a task."""

        with self._lock:
            drained: list[RoutedEvent] = []
            retained: deque[RoutedEvent] = deque()
            while self._items:
                item = self._items.popleft()
                if item.decision.task_id == task_id:
                    drained.append(item)
                else:
                    retained.append(item)
            self._items = retained
            self._estimated_tokens = sum(_event_tokens(item) for item in retained)
            return tuple(drained)

    @property
    def estimated_tokens(self) -> int:
        with self._lock:
            return self._estimated_tokens

    def snapshot(self) -> tuple[RoutedEvent, ...]:
        with self._lock:
            return tuple(self._items)

    def clear(self) -> int:
        with self._lock:
            count = len(self._items)
            self._items.clear()
            self._estimated_tokens = 0
            return count


class HeldQueue:
    """Inputs retained while the active task is cancelling."""

    def __init__(
        self, max_items: int = 100, *, max_estimated_tokens: int = 8_000
    ) -> None:
        if max_items <= 0:
            raise ValueError("max_items must be positive")
        if max_estimated_tokens <= 0:
            raise ValueError("max_estimated_tokens must be positive")
        self._items: deque[RoutedEvent] = deque()
        self.max_items = max_items
        self.max_estimated_tokens = max_estimated_tokens
        self._estimated_tokens = 0
        self._lock = Lock()

    def put(self, event: RoutedEvent) -> None:
        if event.decision.destination is not RouteDestination.HELD:
            raise ValueError("HeldQueue only accepts held events")
        with self._lock:
            if len(self._items) >= self.max_items:
                raise OverflowError("held queue is full")
            event_tokens = _event_tokens(event)
            if self._estimated_tokens + event_tokens > self.max_estimated_tokens:
                raise OverflowError("held queue token budget is full")
            self._items.append(event)
            self._estimated_tokens += event_tokens

    def drain(self, *, task_id: str | None = None) -> tuple[RoutedEvent, ...]:
        with self._lock:
            if task_id is None:
                items = tuple(self._items)
                self._items.clear()
                self._estimated_tokens = 0
                return items
            drained: list[RoutedEvent] = []
            retained: deque[RoutedEvent] = deque()
            while self._items:
                item = self._items.popleft()
                if item.decision.task_id == task_id:
                    drained.append(item)
                else:
                    retained.append(item)
            self._items = retained
            self._estimated_tokens = sum(_event_tokens(item) for item in retained)
            return tuple(drained)

    @property
    def estimated_tokens(self) -> int:
        with self._lock:
            return self._estimated_tokens

    def clear(self) -> int:
        return len(self.drain())

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)


@dataclass(frozen=True, slots=True)
class ScheduleResult:
    immediate: tuple[RoutedEvent, ...] = ()
    queued: bool = False
    rejected: bool = False
    reason: str = ""


class Scheduler:
    def __init__(
        self,
        pending: PendingQueue | None = None,
        held: HeldQueue | None = None,
        dead_letters: DeadLetterQueue | None = None,
    ) -> None:
        self.pending = pending if pending is not None else PendingQueue()
        self.held = held if held is not None else HeldQueue()
        self.dead_letters = (
            dead_letters if dead_letters is not None else DeadLetterQueue()
        )

    def schedule(self, event: RoutedEvent) -> ScheduleResult:
        destination = event.decision.destination
        try:
            if destination is RouteDestination.PENDING:
                self.pending.put(event)
                return ScheduleResult(queued=True)
            if destination is RouteDestination.HELD:
                self.held.put(event)
                return ScheduleResult(queued=True)
        except OverflowError as error:
            reason = str(error)
            self.dead_letters.put(event.event, reason)
            return ScheduleResult(rejected=True, reason=reason)
        if destination is RouteDestination.DROP:
            self.dead_letters.put(event.event, event.decision.reason)
            return ScheduleResult(rejected=True, reason=event.decision.reason)
        return ScheduleResult(immediate=(event,))

    def safe_point(self, task_id: str) -> tuple[RoutedEvent, ...]:
        return self.pending.drain_compatible(task_id=task_id)


def combine_input(events: Iterable[RoutedEvent]) -> str:
    """Combine a pending snapshot into one model input without losing IDs."""

    parts = [
        f"[event_id={item.event.event_id}]\n{content}"
        for item in events
        if (content := str(item.event.payload.get("content", "")).strip())
    ]
    if not parts:
        return ""
    return (
        "Please handle all of these pending messages in one response:\n\n"
        + "\n\n".join(parts)
    )
