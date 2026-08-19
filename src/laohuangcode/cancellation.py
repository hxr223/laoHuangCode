"""Cooperative, task-scoped cancellation primitives."""

from __future__ import annotations

from collections.abc import Callable
from threading import Event, Lock
from time import monotonic


class CancellationError(RuntimeError):
    """Raised by :meth:`CancelToken.throw_if_cancelled`."""


CancelCallback = Callable[[str], None]


class CancelToken:
    """A thread-safe, idempotent cancellation token.

    Registered callbacks run synchronously in the thread that wins the first
    call to :meth:`cancel`. A callback registered after cancellation runs
    immediately in the registering thread.
    """

    def __init__(self) -> None:
        self._event = Event()
        self._lock = Lock()
        self._reason: str | None = None
        self._requested_at: float | None = None
        self._callbacks: dict[int, CancelCallback] = {}
        self._callback_id = 0

    @property
    def reason(self) -> str | None:
        with self._lock:
            return self._reason

    @property
    def requested_at(self) -> float | None:
        with self._lock:
            return self._requested_at

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def is_cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self, reason: str = "cancelled") -> bool:
        if not reason:
            reason = "cancelled"
        with self._lock:
            if self._event.is_set():
                return False
            self._reason = reason
            self._requested_at = monotonic()
            callbacks = tuple(self._callbacks.values())
            self._callbacks.clear()
            self._event.set()
        for callback in callbacks:
            try:
                callback(reason)
            except Exception:
                # Cancellation must remain effective even if a cleanup hook is
                # faulty; owners can report their own cleanup failures.
                continue
        return True

    def wait(self, timeout: float | None = None) -> bool:
        return self._event.wait(timeout)

    def throw_if_cancelled(self) -> None:
        if self._event.is_set():
            raise CancellationError(self.reason or "cancelled")

    def register(self, callback: CancelCallback) -> Callable[[], None]:
        """Register a cancellation hook and return an unregister function."""

        with self._lock:
            if self._event.is_set():
                reason = self._reason or "cancelled"
                callback_id = None
            else:
                self._callback_id += 1
                callback_id = self._callback_id
                self._callbacks[callback_id] = callback
                reason = None
        if reason is not None:
            try:
                callback(reason)
            except Exception:
                pass

        def unregister() -> None:
            if callback_id is None:
                return
            with self._lock:
                self._callbacks.pop(callback_id, None)

        return unregister
