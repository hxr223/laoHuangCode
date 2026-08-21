"""Streaming, cancellable execution for the Bash tool.

The runner deliberately owns process lifecycle and pipe draining, while callers
decide how emitted events are presented.  It targets macOS and Linux, where a
new process session lets cancellation terminate the whole command process group.
"""

from __future__ import annotations

import codecs
from dataclasses import dataclass
import os
from pathlib import Path
import queue
import signal
import subprocess
import threading
import time
from typing import Any, Literal, Mapping


BashStatus = Literal[
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "spawn_failed",
]

_READ_SIZE = 4096
_FLUSH_INTERVAL = 0.04
_FLUSH_CHARS = 4096
_TERMINATION_GRACE = 2.0
MODEL_API_KEY_ENV_NAMES = (
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "LAOHUANG_API_KEY",
)


@dataclass(slots=True)
class ToolExecutionContext:
    """Runtime metadata and optional cooperative services for a tool call."""

    session_id: str | None = None
    task_id: str | None = None
    tool_call_id: str | None = None
    cancel_token: Any | None = None
    event_sink: Any | None = None

    def is_cancelled(self) -> bool:
        token = self.cancel_token
        if token is None:
            return False
        checker = getattr(token, "is_cancelled", None)
        if callable(checker):
            return bool(checker())
        checker = getattr(token, "is_set", None)
        if callable(checker):
            return bool(checker())
        return bool(getattr(token, "cancelled", False))

    @property
    def cancellation_reason(self) -> str:
        reason = getattr(self.cancel_token, "reason", None)
        return str(reason) if reason else "cancelled"

    def publish(self, kind: str, payload: dict[str, Any]) -> None:
        """Publish through EventBus, with a tiny callback fallback for tests."""

        sink = self.event_sink
        if sink is None:
            return

        publisher = getattr(sink, "publish", None)
        if callable(publisher):
            # Import lazily so the runner remains usable during runtime startup
            # and does not create a dependency cycle with the event definitions.
            from .events import EventKind, EventSource

            publisher(
                EventKind(kind),
                source=EventSource.TOOL,
                session_id=self.session_id or "local",
                task_id=self.task_id,
                correlation_id=self.tool_call_id,
                payload=payload,
            )
            return

        if callable(sink):
            sink(kind, payload)


@dataclass(slots=True)
class BashResult:
    status: BashStatus
    stdout: str = ""
    stderr: str = ""
    exit_code: int | None = None
    error: str | None = None
    duration_ms: int = 0
    truncated: bool = False

    @property
    def ok(self) -> bool:
        return self.status == "completed" and self.exit_code == 0

    def as_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "ok": self.ok,
            "status": self.status,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "duration_ms": self.duration_ms,
            "truncated": self.truncated,
        }
        if self.error:
            result["error"] = self.error
        return result


class _BoundedOutput:
    """Keep a 40% head and 60% tail without retaining unbounded output."""

    def __init__(self, limit: int) -> None:
        self.limit = max(0, limit)
        self.head_limit = int(self.limit * 0.4)
        self.tail_limit = self.limit - self.head_limit
        self.total_chars = 0
        self._whole = ""
        self._head = ""
        self._tail = ""
        self._truncated = False

    def append(self, text: str) -> None:
        if not text:
            return
        self.total_chars += len(text)
        if self.limit == 0:
            self._truncated = True
            return

        if not self._truncated and len(self._whole) + len(text) <= self.limit:
            self._whole += text
            return

        if not self._truncated:
            combined = self._whole + text
            self._head = combined[: self.head_limit]
            self._tail = combined[-self.tail_limit :] if self.tail_limit else ""
            self._whole = ""
            self._truncated = True
            return

        if self.tail_limit:
            self._tail = (self._tail + text)[-self.tail_limit :]

    def render(self) -> str:
        if not self._truncated:
            return self._whole
        retained = len(self._head) + len(self._tail)
        omitted = max(0, self.total_chars - retained)
        marker = f"\n...[truncated {omitted} chars]...\n"
        return self._head + marker + self._tail

    @property
    def truncated(self) -> bool:
        return self._truncated


class _TerminalSanitizer:
    """Incrementally remove terminal control sequences from untrusted output."""

    def __init__(self) -> None:
        self._state = "normal"

    def feed(self, text: str) -> str:
        safe: list[str] = []
        for character in text:
            code = ord(character)
            if self._state == "normal":
                if character == "\x1b":
                    self._state = "escape"
                elif character == "\r":
                    safe.append("\n")
                elif character in ("\n", "\t") or code >= 0x20:
                    if code != 0x7F:
                        safe.append(character)
                continue

            if self._state == "escape":
                if character == "[":
                    self._state = "csi"
                elif character in ("P", "X", "^", "_"):
                    self._state = "string"
                elif character == "]":
                    self._state = "osc"
                else:
                    self._state = "normal"
                continue

            if self._state == "csi":
                if 0x40 <= code <= 0x7E:
                    self._state = "normal"
                continue

            if self._state in ("osc", "string"):
                if character == "\x07":
                    self._state = "normal"
                elif character == "\x1b":
                    self._state = "string_escape"
                continue

            if self._state == "string_escape":
                if character == "\\":
                    self._state = "normal"
                elif character != "\x1b":
                    self._state = "string"

        return "".join(safe)


@dataclass(slots=True)
class _ReaderMessage:
    stream: Literal["stdout", "stderr"]
    text: str | None


def _read_pipe(
    stream: Literal["stdout", "stderr"],
    pipe: Any,
    messages: queue.Queue[_ReaderMessage],
) -> None:
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    sanitizer = _TerminalSanitizer()
    try:
        while True:
            data = os.read(pipe.fileno(), _READ_SIZE)
            if not data:
                break
            text = sanitizer.feed(decoder.decode(data, final=False))
            if text:
                messages.put(_ReaderMessage(stream, text))
        final_text = sanitizer.feed(decoder.decode(b"", final=True))
        if final_text:
            messages.put(_ReaderMessage(stream, final_text))
    except (OSError, ValueError):
        # Pipes can be closed by cancellation cleanup while readers are active.
        pass
    finally:
        messages.put(_ReaderMessage(stream, None))


def _terminate_process_group(
    process: subprocess.Popen[bytes], grace_seconds: float = _TERMINATION_GRACE
) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except OSError:
        process.terminate()

    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        # poll() reaps an exited group leader; otherwise a zombie can make the
        # group look alive for the entire grace period.
        process.poll()
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            process.wait(timeout=0)
            return
        except PermissionError:
            break
        time.sleep(0.02)

    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        return
    except OSError:
        process.kill()
    try:
        process.wait(timeout=1.0)
    except subprocess.TimeoutExpired:
        pass


def _clean_environment(environment: Mapping[str, str]) -> dict[str, str]:
    cleaned = dict(environment)
    for name in MODEL_API_KEY_ENV_NAMES:
        cleaned.pop(name, None)
    return cleaned


def run_bash(
    command: str,
    *,
    cwd: Path,
    timeout: float,
    max_output_chars: int,
    context: ToolExecutionContext | None = None,
    env: Mapping[str, str] | None = None,
) -> BashResult:
    """Run one non-interactive Bash command and emit sanitized output deltas."""

    invoked_at = time.monotonic()
    execution = context or ToolExecutionContext()
    if execution.is_cancelled():
        result = BashResult(
            status="cancelled",
            error=execution.cancellation_reason,
            duration_ms=int((time.monotonic() - invoked_at) * 1000),
        )
        execution.publish("tool.finished", result.as_dict())
        return result

    environment = _clean_environment(env if env is not None else os.environ)
    try:
        process = subprocess.Popen(
            ["/bin/bash", "-lc", command],
            cwd=cwd,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            start_new_session=True,
        )
    except (OSError, TypeError, ValueError) as error:
        result = BashResult(
            status="spawn_failed",
            error=str(error),
            duration_ms=int((time.monotonic() - invoked_at) * 1000),
        )
        execution.publish("tool.finished", result.as_dict())
        return result

    execution.publish(
        "tool.started",
        {"name": "bash", "arguments": {"command": command}},
    )
    assert process.stdout is not None
    assert process.stderr is not None

    messages: queue.Queue[_ReaderMessage] = queue.Queue(maxsize=256)
    readers = [
        threading.Thread(
            target=_read_pipe,
            args=("stdout", process.stdout, messages),
            name=f"bash-stdout-{process.pid}",
            daemon=True,
        ),
        threading.Thread(
            target=_read_pipe,
            args=("stderr", process.stderr, messages),
            name=f"bash-stderr-{process.pid}",
            daemon=True,
        ),
    ]
    for reader in readers:
        reader.start()

    outputs = {
        "stdout": _BoundedOutput(max_output_chars),
        "stderr": _BoundedOutput(max_output_chars),
    }
    pending = {"stdout": "", "stderr": ""}
    stream_sequence = {"stdout": 0, "stderr": 0}
    finished_streams: set[str] = set()
    started_at = time.monotonic()
    last_flush = started_at
    terminal_status: BashStatus | None = None

    def flush(stream: Literal["stdout", "stderr"]) -> None:
        text = pending[stream]
        if not text:
            return
        pending[stream] = ""
        outputs[stream].append(text)
        stream_sequence[stream] += 1
        execution.publish(
            "tool.output_delta",
            {
                "name": "bash",
                "stream": stream,
                "text": text,
                "stream_sequence": stream_sequence[stream],
            },
        )

    try:
        while len(finished_streams) < 2 or process.poll() is None:
            now = time.monotonic()
            if terminal_status is None and execution.is_cancelled():
                terminal_status = "cancelled"
                _terminate_process_group(process)
            elif terminal_status is None and timeout >= 0 and now - started_at >= timeout:
                terminal_status = "timed_out"
                _terminate_process_group(process)

            try:
                message = messages.get(timeout=0.01)
            except queue.Empty:
                message = None

            if message is not None:
                if message.text is None:
                    finished_streams.add(message.stream)
                else:
                    pending[message.stream] += message.text
                    if len(pending[message.stream]) >= _FLUSH_CHARS:
                        flush(message.stream)

            now = time.monotonic()
            if now - last_flush >= _FLUSH_INTERVAL:
                flush("stdout")
                flush("stderr")
                last_flush = now

        flush("stdout")
        flush("stderr")
    finally:
        if process.poll() is None:
            _terminate_process_group(process)
        for pipe in (process.stdout, process.stderr):
            try:
                pipe.close()
            except OSError:
                pass
        for reader in readers:
            reader.join(timeout=1.0)

    exit_code = process.poll()
    stdout = outputs["stdout"].render()
    stderr = outputs["stderr"].render()
    duration_ms = int((time.monotonic() - invoked_at) * 1000)
    truncated = outputs["stdout"].truncated or outputs["stderr"].truncated
    if terminal_status == "cancelled":
        result = BashResult(
            status="cancelled",
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
            error=execution.cancellation_reason,
            duration_ms=duration_ms,
            truncated=truncated,
        )
    elif terminal_status == "timed_out":
        result = BashResult(
            status="timed_out",
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
            error=f"Bash command timed out after {timeout} seconds",
            duration_ms=duration_ms,
            truncated=truncated,
        )
    elif exit_code == 0:
        result = BashResult(
            status="completed",
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
            duration_ms=duration_ms,
            truncated=truncated,
        )
    else:
        result = BashResult(
            status="failed",
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
            error=f"Bash command exited with code {exit_code}",
            duration_ms=duration_ms,
            truncated=truncated,
        )

    execution.publish("tool.finished", result.as_dict())
    return result
