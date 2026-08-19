"""Single-active-task runtime coordination for laoHuangCode."""

from __future__ import annotations

import inspect
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from enum import StrEnum
from threading import Event, Lock, Thread, current_thread
from time import monotonic
from typing import Any
from uuid import uuid4

from .cancellation import CancelToken, CancellationError
from .events import EventBus, EventEnvelope, EventKind, EventSource
from .routing import (
    DeadLetterQueue,
    EventRouter,
    HeldQueue,
    PendingQueue,
    RouteDecision,
    RouteDestination,
    RouteStrategy,
    RouteTiming,
    RoutedEvent,
    Scheduler,
    TaskRecord,
    TaskRegistry,
    TaskState,
    combine_input,
)


class SessionState(StrEnum):
    IDLE = "idle"
    RUNNING = "running"
    CANCELLING = "cancelling"
    STOPPED = "stopped"


@dataclass(frozen=True, slots=True)
class PendingInputBatch:
    events: tuple[RoutedEvent, ...] = ()
    content: str = ""

    @property
    def event_ids(self) -> tuple[str, ...]:
        return tuple(item.event.event_id for item in self.events)

    def __bool__(self) -> bool:
        return bool(self.events)


@dataclass(frozen=True, slots=True)
class Submission:
    event: EventEnvelope
    routed: RoutedEvent
    task_id: str | None
    queued: bool
    control: bool = False
    rejected: bool = False
    reason: str = ""


class TaskContext:
    """Capabilities exposed to one model/tool worker invocation."""

    def __init__(self, session: AgentSession, task_id: str) -> None:
        self._session = session
        self.session_id = session.session_id
        self.task_id = task_id
        self._claimed_input_event_ids: tuple[str, ...] = ()

    @property
    def cancel_token(self) -> CancelToken:
        record = self._session.task_registry.get(self.task_id)
        if record is None:
            raise RuntimeError(f"task no longer exists: {self.task_id}")
        return record.cancel_token

    @property
    def event_bus(self) -> EventBus:
        return self._session.event_bus

    def is_active(self) -> bool:
        return self._session.is_task_active(self.task_id)

    def publish(
        self,
        kind: EventKind | str,
        *,
        source: EventSource | str,
        correlation_id: str | None = None,
        payload: Mapping[str, Any] | None = None,
    ) -> EventEnvelope:
        return self._session._publish_internal_event(
            kind,
            source=source,
            task_id=self.task_id,
            correlation_id=correlation_id,
            payload=payload,
        )

    def set_state(self, state: TaskState) -> bool:
        return self._session._set_running_state(self.task_id, state)

    def model_started(self) -> bool:
        return self.set_state(TaskState.RUNNING_MODEL)

    def model_request_opened(self) -> bool:
        """Acknowledge claimed input only once the SDK opened its request."""

        acknowledged = self._session._ack_claimed_input(
            self.task_id, self._claimed_input_event_ids
        )
        if acknowledged:
            self._claimed_input_event_ids = ()
        return acknowledged

    def tools_started(self) -> bool:
        return self.set_state(TaskState.RUNNING_TOOLS)

    def safe_point(self) -> PendingInputBatch:
        """Atomically take one compatible pending batch for this task."""

        return self._session._drain_pending(self.task_id)

    def _set_claimed_input(self, batch: PendingInputBatch | None) -> None:
        self._claimed_input_event_ids = batch.event_ids if batch else ()

    def commit_input(
        self,
        callback: Callable[[], None],
        rollback: Callable[[], None] = lambda: None,
    ) -> bool:
        return self._session._commit_claimed_input(
            self.task_id,
            self._claimed_input_event_ids,
            callback,
            rollback=rollback,
        )

    def commit_pending(
        self,
        batch: PendingInputBatch,
        callback: Callable[[], None],
        rollback: Callable[[], None] = lambda: None,
    ) -> bool:
        committed = self._session._commit_claimed_input(
            self.task_id,
            batch.event_ids,
            callback,
            rollback=rollback,
        )
        if committed:
            self._claimed_input_event_ids = batch.event_ids
        return committed

    def commit_if_active(self, callback: Callable[[], None]) -> bool:
        """Atomically reject history commits once cancellation has won."""

        return self._session._commit_if_active(self.task_id, callback)


TaskRunner = Callable[..., str | None]


class AgentSession:
    """Own runtime coordination while the CodingAgent owns model/tool logic."""

    def __init__(
        self,
        runner: TaskRunner | Any,
        *,
        session_id: str | None = None,
        event_bus: EventBus | None = None,
        task_registry: TaskRegistry | None = None,
        semantic_classifier: Callable[..., Any] | None = None,
        safety_policy: Callable[..., Any] | None = None,
    ) -> None:
        self.session_id = session_id or uuid4().hex
        self.event_bus = event_bus or EventBus()
        self.task_registry = task_registry or TaskRegistry()
        self.pending = PendingQueue()
        self.held = HeldQueue()
        self.dead_letters = DeadLetterQueue()
        self.scheduler = Scheduler(self.pending, self.held, self.dead_letters)
        self.router = EventRouter(
            self.task_registry,
            semantic_classifier=semantic_classifier,
            safety_policy=safety_policy,
        )
        self.runner = runner
        self._coordination_lock = Lock()
        self._state_lock = Lock()
        self._state = SessionState.IDLE
        self._worker: Thread | None = None
        self._close_requested = False
        self._inflight_pending: dict[str, tuple[RoutedEvent, ...]] = {}
        self._inflight_rollbacks: dict[str, Callable[[], None]] = {}
        self._idle = Event()
        self._idle.set()
        self.event_bus.publish(
            EventKind.SESSION_READY,
            source=EventSource.SESSION,
            session_id=self.session_id,
            payload={},
        )

    @property
    def state(self) -> SessionState:
        with self._state_lock:
            return self._state

    @property
    def active_task(self) -> TaskRecord | None:
        return self.task_registry.active()

    @property
    def pending_count(self) -> int:
        return len(self.pending)

    @property
    def held_count(self) -> int:
        return len(self.held)

    def submit_input(
        self,
        content: str,
        *,
        strategy: RouteStrategy | str | None = None,
    ) -> Submission:
        if self.state is SessionState.STOPPED:
            raise RuntimeError("session is stopped")
        text = content.strip()
        if not text:
            raise ValueError("input must not be empty")
        if text == "/cancel":
            event = self._publish_input(
                EventKind.INPUT_SLASH_COMMAND, text, strategy=None
            )
            routed = self.router.route(event)
            self._cancel_routed(routed)
            return Submission(
                event,
                routed,
                routed.decision.task_id,
                queued=False,
                control=True,
            )

        kind = (
            EventKind.INPUT_SLASH_COMMAND
            if text.startswith("/")
            else EventKind.INPUT_USER_MESSAGE
        )
        event = self._publish_input(kind, text, strategy=strategy)
        routing_task_id = self.task_registry.active_task_id
        # Layer-three classification may make a network request. Never hold
        # Session coordination while waiting for it; the worker must remain
        # free to finish, cancel, or reach a safe point.
        routed = self.router.route(event)
        with self._coordination_lock:
            routed = self._refresh_route_for_current_task(
                routed, routing_task_id=routing_task_id
            )
            self._publish_route(routed)
            scheduled = self.scheduler.schedule(routed)
            task_id = routed.decision.task_id
            if routed.decision.destination is RouteDestination.NEW_TASK:
                task_id = self._start_task_locked(text, input_event_id=event.event_id)
            elif routed.decision.destination is RouteDestination.PENDING:
                self.event_bus.publish(
                    EventKind.INPUT_PENDING,
                    source=EventSource.SESSION,
                    session_id=self.session_id,
                    task_id=task_id,
                    correlation_id=event.event_id,
                    payload={"pending_count": len(self.pending)},
                )
            elif routed.decision.destination is RouteDestination.HELD:
                self.event_bus.publish(
                    EventKind.INPUT_HELD,
                    source=EventSource.SESSION,
                    session_id=self.session_id,
                    task_id=task_id,
                    correlation_id=event.event_id,
                    payload={"held_count": len(self.held)},
                )
            if scheduled.rejected:
                self.event_bus.publish(
                    EventKind.ROUTING_REJECTED,
                    source=EventSource.ROUTER,
                    session_id=self.session_id,
                    task_id=task_id,
                    correlation_id=event.event_id,
                    payload={
                        "reason": scheduled.reason,
                        "destination": RouteDestination.DROP.value,
                        "layer": 4,
                    },
                )
            return Submission(
                event,
                routed,
                task_id,
                queued=scheduled.queued,
                control=routed.decision.destination is RouteDestination.CONTROL,
                rejected=scheduled.rejected,
                reason=scheduled.reason,
            )

    def _refresh_route_for_current_task(
        self, routed: RoutedEvent, *, routing_task_id: str | None
    ) -> RoutedEvent:
        """Repair a decision if task state changed during semantic routing."""

        decision = routed.decision
        active = self.task_registry.active()
        destination = decision.destination
        if routing_task_id is not None:
            original = self.task_registry.get(routing_task_id)
            if active is not None and active.task_id == routing_task_id:
                if active.state is not TaskState.CANCELLING:
                    return routed
            elif (
                active is None
                and original is not None
                and original.state is TaskState.COMPLETED
            ):
                replacement = RouteDecision(
                    None,
                    RouteDestination.NEW_TASK,
                    RouteTiming.IMMEDIATE,
                    RouteStrategy.EXECUTE,
                    1.0,
                    "original task completed while routing; start follow-up task",
                    4,
                )
                return RoutedEvent(routed.event, replacement)
            replacement = RouteDecision(
                routing_task_id,
                RouteDestination.HELD,
                RouteTiming.AFTER_CANCEL,
                RouteStrategy.FOLLOW_UP,
                1.0,
                "original task stopped or changed while routing; hold input",
                4,
            )
            return RoutedEvent(routed.event, replacement)

        stale = (
            destination is RouteDestination.NEW_TASK and active is not None
        ) or (
            destination in {RouteDestination.PENDING, RouteDestination.HELD}
            and (active is None or decision.task_id != active.task_id)
        )
        if not stale:
            return routed
        if active is None:
            replacement = RouteDecision(
                None,
                RouteDestination.NEW_TASK,
                RouteTiming.IMMEDIATE,
                RouteStrategy.EXECUTE,
                1.0,
                "task state changed while routing; start a new task",
                4,
            )
        elif active.state is TaskState.CANCELLING:
            replacement = RouteDecision(
                active.task_id,
                RouteDestination.HELD,
                RouteTiming.AFTER_CANCEL,
                RouteStrategy.FOLLOW_UP,
                1.0,
                "task began cancelling while routing; hold input",
                4,
            )
        else:
            replacement = RouteDecision(
                active.task_id,
                RouteDestination.PENDING,
                RouteTiming.SAFE_POINT,
                RouteStrategy.FOLLOW_UP,
                1.0,
                "active task changed while routing; queue safe follow-up",
                4,
            )
        return RoutedEvent(routed.event, replacement)

    def request_cancel(self, reason: str = "cancelled by user") -> bool:
        event = self.event_bus.publish(
            EventKind.INPUT_CANCEL_REQUESTED,
            source=EventSource.USER,
            session_id=self.session_id,
            payload={"reason": reason},
        )
        routed = self.router.route(event)
        return self._cancel_routed(routed, reason=reason)

    def cancel_active_task(self) -> bool:
        """Command-facing alias for task-scoped cancellation."""

        return self.request_cancel("cancelled by user")

    def queue_status(self) -> dict[str, int]:
        return {
            "pending": len(self.pending),
            "held": len(self.held),
            "dead_letters": len(self.dead_letters),
            "pending_tokens": self.pending.estimated_tokens,
            "held_tokens": self.held.estimated_tokens,
        }

    def publish_notice(self, text: str, *, style: str = "") -> EventEnvelope:
        """Publish user-facing local feedback in canonical event order."""

        return self.event_bus.publish(
            EventKind.UI_MESSAGE,
            source=EventSource.SESSION,
            session_id=self.session_id,
            payload={"text": text, "style": style},
        )

    def clear_queues(self) -> int:
        return self.pending.clear() + self.held.clear() + self.dead_letters.clear()

    def _publish_internal_event(
        self,
        kind: EventKind | str,
        *,
        source: EventSource | str,
        task_id: str,
        correlation_id: str | None,
        payload: Mapping[str, Any] | None,
    ) -> EventEnvelope:
        """Normalize and route a model/tool callback before fan-out."""

        event = self.event_bus.factory.create(
            kind,
            source=source,
            session_id=self.session_id,
            task_id=task_id,
            correlation_id=correlation_id,
            payload=payload,
        )
        routed = self.router.route(event)
        self._publish_route(routed)
        if routed.decision.destination is RouteDestination.DROP:
            self.dead_letters.put(event, routed.decision.reason)
            return event
        return self.event_bus.publish_event(event)

    def _cancel_routed(
        self, routed: RoutedEvent, *, reason: str = "cancelled by user"
    ) -> bool:
        self._publish_route(routed)
        task_id = routed.decision.task_id
        if task_id is None:
            return False
        token: CancelToken | None = None
        with self._coordination_lock:
            record = self.task_registry.get(task_id)
            if record is None or record.state in {
                TaskState.CANCELLED,
                TaskState.COMPLETED,
                TaskState.FAILED,
            }:
                return False
            self.task_registry.transition(task_id, TaskState.CANCELLING)
            self._set_session_state(SessionState.CANCELLING)
            self._hold_task_inputs_locked(
                task_id, reason="held because its task is cancelling"
            )
            self._publish_task_state(task_id, TaskState.CANCELLING)
            token = record.cancel_token
        # Cancellation hooks may close streams or processes and must never run
        # while Session coordination is locked.
        return token.cancel(reason) if token is not None else False

    def wait_for_idle(self, timeout: float | None = None) -> bool:
        return self._idle.wait(timeout)

    def is_task_active(self, task_id: str) -> bool:
        active = self.task_registry.active()
        return active is not None and active.task_id == task_id

    def resume_held(self) -> int:
        """Start all held user inputs as one new task when currently idle."""

        with self._coordination_lock:
            if self.task_registry.active() is not None:
                return 0
            held = self.held.drain()
            content = combine_input(held)
            if not content:
                return 0
            self._start_task_locked(content, input_event_id=None)
            return len(held)

    def clear_held(self) -> int:
        return len(self.held.drain())

    def close(self, *, wait: bool = True, timeout: float | None = None) -> bool:
        if self.state is SessionState.STOPPED:
            return True
        self._close_requested = True
        if self.active_task is not None:
            self.request_cancel("session closed")
        clean = True
        if wait:
            deadline = None if timeout is None else monotonic() + timeout
            clean = self.wait_for_idle(timeout)
            worker = self._worker
            if worker is not None and worker is not current_thread():
                remaining = (
                    None
                    if deadline is None
                    else max(0.0, deadline - monotonic())
                )
                worker.join(remaining)
                clean = clean and not worker.is_alive()
        elif self._worker is not None and self._worker.is_alive():
            clean = False
        if not clean:
            return False
        self._finalize_stop()
        return True

    def _finalize_stop(self) -> None:
        with self._state_lock:
            if self._state is SessionState.STOPPED:
                return
            self._state = SessionState.STOPPED
        self.event_bus.publish(
            EventKind.SESSION_STOPPED,
            source=EventSource.SESSION,
            session_id=self.session_id,
            payload={},
        )
        self.event_bus.close()

    def _publish_input(
        self,
        kind: EventKind,
        content: str,
        *,
        strategy: RouteStrategy | str | None,
    ) -> EventEnvelope:
        payload: dict[str, Any] = {"content": content}
        if strategy is not None:
            payload["strategy"] = RouteStrategy(strategy).value
        return self.event_bus.publish(
            kind,
            source=EventSource.USER,
            session_id=self.session_id,
            payload=payload,
        )

    def _publish_route(self, routed: RoutedEvent) -> None:
        decision = routed.decision
        kind = (
            EventKind.ROUTING_REJECTED
            if decision.destination is RouteDestination.DROP
            else EventKind.ROUTING_DECIDED
        )
        self.event_bus.publish(
            kind,
            source=EventSource.ROUTER,
            session_id=self.session_id,
            task_id=decision.task_id,
            correlation_id=routed.event.event_id,
            payload={
                "destination": decision.destination.value,
                "timing": decision.timing.value,
                "strategy": decision.strategy.value,
                "confidence": decision.confidence,
                "reason": decision.reason,
                "layer": decision.layer,
            },
        )

    def _start_task_locked(
        self, content: str, *, input_event_id: str | None
    ) -> str:
        task_id = uuid4().hex
        self.task_registry.register(task_id)
        self._idle.clear()
        self._set_session_state(SessionState.RUNNING)
        self.event_bus.publish(
            EventKind.TASK_STARTED,
            source=EventSource.SESSION,
            session_id=self.session_id,
            task_id=task_id,
            correlation_id=input_event_id,
            payload={
                "pending_count": len(self.pending),
                "held_count": len(self.held),
            },
        )
        worker = Thread(
            target=self._run_task,
            args=(task_id, content),
            name=f"laohuang-task-{task_id[:8]}",
            daemon=True,
        )
        self._worker = worker
        worker.start()
        return task_id

    def _run_task(self, task_id: str, content: str) -> None:
        context = TaskContext(self, task_id)
        current_input = content
        current_batch: PendingInputBatch | None = None
        result: str | None = None
        try:
            while True:
                context.cancel_token.throw_if_cancelled()
                self._set_running_state(task_id, TaskState.RUNNING_MODEL)
                context._set_claimed_input(current_batch)
                result = self._invoke_runner(current_input, context)
                if current_batch:
                    self._ack_claimed_input(task_id, current_batch.event_ids)
                context.cancel_token.throw_if_cancelled()
                cancelled_at_boundary = False
                with self._coordination_lock:
                    batch = self._drain_pending_unlocked(task_id)
                    if batch:
                        current_input = batch.content
                        current_batch = batch
                        continue
                    record = self.task_registry.get(task_id)
                    cancelled_at_boundary = bool(
                        record is None
                        or record.state is TaskState.CANCELLING
                        or record.cancel_token.is_cancelled()
                    )
                    if not cancelled_at_boundary:
                        self.task_registry.transition(
                            task_id, TaskState.COMPLETED, result=result
                        )
                        self.event_bus.publish(
                            EventKind.TASK_COMPLETED,
                            source=EventSource.SESSION,
                            session_id=self.session_id,
                            task_id=task_id,
                            payload={
                                "result": result or "",
                                "pending_count": len(self.pending),
                                "held_count": len(self.held),
                            },
                        )
                if cancelled_at_boundary:
                    self._finish_cancelled(task_id)
                break
        except CancellationError:
            self._finish_cancelled(task_id)
        except Exception as error:
            record = self.task_registry.get(task_id)
            if record is not None and record.cancel_token.is_cancelled():
                self._finish_cancelled(task_id)
            else:
                with self._coordination_lock:
                    self._hold_task_inputs_locked(
                        task_id, reason="held because its task failed"
                    )
                    self.task_registry.transition(
                        task_id, TaskState.FAILED, error=str(error)
                    )
                    self.event_bus.publish(
                        EventKind.TASK_FAILED,
                        source=EventSource.SESSION,
                        session_id=self.session_id,
                        task_id=task_id,
                        payload={
                            "error": str(error),
                            "pending_count": len(self.pending),
                            "held_count": len(self.held),
                        },
                    )
        finally:
            if self.state is not SessionState.STOPPED:
                self._set_session_state(SessionState.IDLE)
            self._idle.set()
            if self._close_requested:
                self._finalize_stop()

    def _finish_cancelled(self, task_id: str) -> None:
        with self._coordination_lock:
            record = self.task_registry.get(task_id)
            if record is None or record.state in {
                TaskState.CANCELLED,
                TaskState.COMPLETED,
                TaskState.FAILED,
            }:
                return
            self._hold_task_inputs_locked(
                task_id, reason="held because its task was cancelled"
            )
            self.task_registry.transition(task_id, TaskState.CANCELLED)
            self.event_bus.publish(
                EventKind.TASK_CANCELLED,
                source=EventSource.SESSION,
                session_id=self.session_id,
                task_id=task_id,
                payload={
                    "reason": record.cancel_token.reason or "cancelled",
                    "pending_count": len(self.pending),
                    "held_count": len(self.held),
                },
            )

    def _hold_task_inputs_locked(self, task_id: str, *, reason: str) -> int:
        """Rollback and preserve every unacknowledged input for a task."""

        rollback = self._inflight_rollbacks.pop(task_id, None)
        if rollback is not None:
            try:
                rollback()
            except Exception:
                pass
        inflight = self._inflight_pending.pop(task_id, ())
        items = (*self.pending.drain_task(task_id), *inflight)
        held_count = 0
        for pending in items:
            held = RoutedEvent(
                pending.event,
                replace(
                    pending.decision,
                    destination=RouteDestination.HELD,
                    timing=RouteTiming.AFTER_CANCEL,
                    strategy=RouteStrategy.FOLLOW_UP,
                    reason=reason,
                    layer=4,
                ),
            )
            try:
                self.held.put(held)
                held_count += 1
            except OverflowError:
                self.dead_letters.put(pending.event, "held queue is full")
                self.event_bus.publish(
                    EventKind.ROUTING_REJECTED,
                    source=EventSource.ROUTER,
                    session_id=self.session_id,
                    task_id=task_id,
                    correlation_id=pending.event.event_id,
                    payload={"reason": "held queue is full"},
                )
        return held_count

    def _invoke_runner(self, content: str, context: TaskContext) -> str | None:
        runner = getattr(self.runner, "run", self.runner)
        try:
            parameters = inspect.signature(runner).parameters.values()
        except (TypeError, ValueError):
            return runner(content)
        parameters = tuple(parameters)
        if "context" in {parameter.name for parameter in parameters} or any(
            parameter.kind is inspect.Parameter.VAR_KEYWORD
            for parameter in parameters
        ):
            return runner(content, context=context)
        positional = tuple(
            parameter
            for parameter in parameters
            if parameter.kind
            in {
                inspect.Parameter.POSITIONAL_ONLY,
                inspect.Parameter.POSITIONAL_OR_KEYWORD,
            }
        )
        if len(positional) >= 2 or any(
            parameter.kind is inspect.Parameter.VAR_POSITIONAL
            for parameter in parameters
        ):
            return runner(content, context)
        return runner(content)

    def _set_running_state(self, task_id: str, state: TaskState) -> bool:
        if state not in {TaskState.RUNNING_MODEL, TaskState.RUNNING_TOOLS}:
            raise ValueError("TaskContext can only enter model or tool running state")
        with self._coordination_lock:
            record = self.task_registry.get(task_id)
            if record is None or record.state in {
                TaskState.CANCELLING,
                TaskState.CANCELLED,
                TaskState.COMPLETED,
                TaskState.FAILED,
            }:
                return False
            if record.state is not state:
                self.task_registry.transition(task_id, state)
                self._publish_task_state(task_id, state)
            return True

    def _commit_if_active(
        self, task_id: str, callback: Callable[[], None]
    ) -> bool:
        with self._coordination_lock:
            record = self.task_registry.get(task_id)
            if (
                record is None
                or record.state is TaskState.CANCELLING
                or record.cancel_token.is_cancelled()
            ):
                return False
            callback()
            return True

    def _commit_claimed_input(
        self,
        task_id: str,
        event_ids: tuple[str, ...],
        callback: Callable[[], None],
        *,
        rollback: Callable[[], None],
    ) -> bool:
        with self._coordination_lock:
            record = self.task_registry.get(task_id)
            if (
                record is None
                or record.state is TaskState.CANCELLING
                or record.cancel_token.is_cancelled()
            ):
                return False
            if event_ids:
                inflight = self._inflight_pending.get(task_id, ())
                if tuple(item.event.event_id for item in inflight) != event_ids:
                    return False
            callback()
            if event_ids:
                self._inflight_rollbacks[task_id] = rollback
            return True

    def _ack_claimed_input(
        self, task_id: str, event_ids: tuple[str, ...]
    ) -> bool:
        if not event_ids:
            return True
        with self._coordination_lock:
            record = self.task_registry.get(task_id)
            inflight = self._inflight_pending.get(task_id, ())
            if (
                record is None
                or record.state is TaskState.CANCELLING
                or record.cancel_token.is_cancelled()
                or tuple(item.event.event_id for item in inflight) != event_ids
            ):
                return False
            self._inflight_pending.pop(task_id, None)
            self._inflight_rollbacks.pop(task_id, None)
            return True

    def _publish_task_state(self, task_id: str, state: TaskState) -> None:
        self.event_bus.publish(
            EventKind.TASK_STATE_CHANGED,
            source=EventSource.SESSION,
            session_id=self.session_id,
            task_id=task_id,
            payload={
                "state": state.value,
                "state_name": state.name,
                "pending_count": len(self.pending),
                "held_count": len(self.held),
            },
        )

    def _drain_pending(self, task_id: str) -> PendingInputBatch:
        with self._coordination_lock:
            return self._drain_pending_unlocked(task_id)

    def _drain_pending_unlocked(self, task_id: str) -> PendingInputBatch:
        record = self.task_registry.get(task_id)
        if record is None or record.state is TaskState.CANCELLING:
            return PendingInputBatch()
        if task_id in self._inflight_pending:
            raise RuntimeError("pending batch is already in flight")
        events = self.scheduler.safe_point(task_id)
        if events:
            self._inflight_pending[task_id] = events
            self._publish_task_state(task_id, record.state)
        return PendingInputBatch(events, combine_input(events))

    def _set_session_state(self, state: SessionState) -> None:
        with self._state_lock:
            self._state = state
