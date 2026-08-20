"""Polished interactive terminal UI for laoHuangCode."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
import json
from pathlib import Path
from queue import Empty, Full, Queue
import threading
from typing import Any

from prompt_toolkit import PromptSession
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.filters import Condition
from prompt_toolkit.formatted_text import HTML
from prompt_toolkit.history import DummyHistory, InMemoryHistory
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.patch_stdout import patch_stdout
from prompt_toolkit.styles import Style
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.text import Text

from .commands import CommandCompleter, CommandRegistry
from .ui_state import UIEventReducer, UIState, UIUpdate


def _input_bindings(
    *,
    is_running: Callable[[], bool] = lambda: False,
    cancel: Callable[[], None] = lambda: None,
    notify: Callable[[str], None] = lambda _message: None,
) -> KeyBindings:
    bindings = KeyBindings()

    @bindings.add("enter")
    def submit(event: Any) -> None:
        buffer = event.current_buffer
        completion_state = getattr(buffer, "complete_state", None)
        completion = getattr(completion_state, "current_completion", None)
        if completion is None and completion_state is not None:
            completions = getattr(completion_state, "completions", ())
            completion = completions[0] if completions else None
        if completion is not None:
            buffer.apply_completion(completion)
            return
        buffer.validate_and_handle()

    @bindings.add("/")
    def insert_slash_and_complete(event: Any) -> None:
        buffer = event.current_buffer
        should_complete = not buffer.text and buffer.cursor_position == 0
        buffer.insert_text("/")
        if should_complete:
            buffer.start_completion(select_first=False)

    @bindings.add("tab")
    def complete_command(event: Any) -> None:
        buffer = event.current_buffer
        completion_state = getattr(buffer, "complete_state", None)
        completion = getattr(completion_state, "current_completion", None)
        if completion is None and completion_state is not None:
            completions = getattr(completion_state, "completions", ())
            completion = completions[0] if completions else None
        if completion is not None:
            buffer.apply_completion(completion)
        elif buffer.text.startswith("/"):
            buffer.start_completion(select_first=True)
        else:
            buffer.insert_text("    ")

    @bindings.add("escape", "enter")
    def insert_newline(event: Any) -> None:
        event.current_buffer.insert_text("\n")

    @bindings.add("c-c")
    def interrupt_or_clear(event: Any) -> None:
        if is_running():
            cancel()
            return
        event.current_buffer.reset()

    @bindings.add("c-d")
    def exit_when_idle(event: Any) -> None:
        if event.current_buffer.text:
            event.current_buffer.delete()
            return
        if is_running():
            notify("A task is still running. Use /cancel before exiting.")
            return
        event.app.exit(exception=EOFError)

    return bindings


@dataclass(frozen=True, slots=True)
class _LocalMessage:
    text: str
    style: str = ""


class PlainEventSink:
    """Append-only renderer used when stdin/stdout are not interactive TTYs.

    Event callbacks and local command feedback share one queue, so only the
    sink's writer thread ever calls ``output_fn`` during a live session.
    """

    def __init__(self, output_fn: Callable[[str], None] = print) -> None:
        self.output_fn = output_fn
        self._queue: Queue[Any] = Queue(maxsize=4_096)
        self._thread = threading.Thread(
            target=self._run,
            name="laohuang-plain-renderer",
            daemon=True,
        )
        self._stopped = False
        self._render_error: Exception | None = None
        self._model_buffers: dict[str, list[str]] = {}
        self._thread.start()

    def publish_event(self, event: Any) -> None:
        if not self._stopped and not _is_hidden_tool_stdout(event):
            self._enqueue(event)

    def write(self, message: str) -> None:
        if not self._stopped:
            self._enqueue(_LocalMessage(message))

    def _enqueue(self, item: Any) -> None:
        kind = str(item.get("kind", "")) if isinstance(item, dict) else ""
        high_frequency = kind in {
            "model.reasoning_delta",
            "model.tool_call_delta",
            "tool.output_delta",
        }
        if high_frequency and self._queue.qsize() >= 3_968:
            return
        try:
            self._queue.put_nowait(item)
        except Full:
            if not high_frequency:
                self._queue.put(item)

    def flush(self) -> None:
        self._queue.join()

    def stop(self, *, drain: bool = True) -> None:
        if self._stopped:
            return
        self._stopped = True
        if drain:
            self.flush()
        else:
            while True:
                try:
                    self._queue.get_nowait()
                except Empty:
                    break
                else:
                    self._queue.task_done()
        try:
            self._queue.put(None, timeout=2)
        except Full:
            return
        self._thread.join(timeout=2)

    def _run(self) -> None:
        while True:
            item = self._queue.get()
            try:
                if item is None:
                    return
                try:
                    if isinstance(item, _LocalMessage):
                        self.output_fn(item.text)
                    else:
                        self._render_event(item)
                except Exception as error:
                    self._render_error = error
            finally:
                self._queue.task_done()

    def _render_event(self, event: Any) -> None:
        if not isinstance(event, dict):
            return
        kind = str(event.get("kind", ""))
        payload = event.get("payload", {})
        if not isinstance(payload, dict):
            payload = {}
        if (
            kind == "tool.output_delta"
            and payload.get("stream", "stdout") == "stdout"
        ):
            return
        dropped = int(payload.get("_projection_dropped", 0) or 0)
        if dropped:
            self.output_fn(
                f"[stream output omitted: {dropped} event(s); runtime continued]"
            )
        correlation_id = str(event.get("correlation_id") or "")[-8:]

        if kind == "model.text_delta":
            text = str(payload.get("text", payload.get("chunk", "")))
            if text:
                self._model_buffers.setdefault(correlation_id, []).append(text)
        elif kind == "model.response_committed":
            text = "".join(self._model_buffers.pop(correlation_id, ()))
            if text:
                self.output_fn(text)
        elif kind in {"model.response_aborted", "model.request_failed"}:
            text = "".join(self._model_buffers.pop(correlation_id, ()))
            if text:
                self.output_fn(text)
                self.output_fn("[response interrupted; not added to context]")
        elif kind == "ui.message":
            self.output_fn(str(payload.get("text", "")))
        elif kind == "tool.started":
            name = str(payload.get("name", "tool"))
            self.output_fn(f"[tool:{correlation_id or 'unknown'}] {name} started")
        elif kind == "tool.output_delta":
            stream = str(payload.get("stream", "stdout"))
            text = str(payload.get("text", payload.get("chunk", "")))
            if text:
                self.output_fn(
                    f"[{correlation_id or 'unknown'}:{stream}] {text}"
                )
        elif kind == "tool.finished":
            status = str(payload.get("status", "completed"))
            self.output_fn(f"[tool:{correlation_id or 'unknown'}] {status}")
        elif kind == "task.failed":
            self.output_fn(f"Error: {payload.get('error', 'Task failed')}")
        elif kind == "task.cancelled":
            self.output_fn(
                "Task cancelled; completed file changes were not reverted."
            )


class TerminalUI:
    """Render interactive agent sessions with Rich and prompt_toolkit."""

    def __init__(
        self,
        *,
        console: Console | None = None,
        session_factory: Callable[..., Any] = PromptSession,
        project_root: Path | None = None,
        provider: str | None = None,
        model: str | None = None,
        dashboard_url: str | None = None,
        command_registry: CommandRegistry | None = None,
        cancel_callback: Callable[[], None] | None = None,
    ) -> None:
        self.console = console or Console()
        self._session_factory = session_factory
        self._session: Any | None = None
        self._question_session: Any | None = None
        self._secret_session: Any | None = None
        self.project_root = project_root
        self.provider = provider
        self.model = model
        self.dashboard_url = dashboard_url
        self.command_registry = command_registry
        self.cancel_callback = cancel_callback
        self.runtime_running_callback: Callable[[], bool] | None = None
        self.state = UIState(provider=provider or "", model=model or "")
        self.reducer = UIEventReducer(self.state)
        # EventBus fan-out must stay non-blocking so cancellation/control
        # events cannot be trapped behind a slow terminal renderer.
        self._event_queue: Queue[Any] = Queue(maxsize=4_096)
        self._event_thread: threading.Thread | None = None
        self._event_stop = threading.Event()
        self._renderer_closed = False
        self._render_error: Exception | None = None
        self._render_lock = threading.RLock()
        self._streaming_response = False
        self._tool_line_start: dict[tuple[str, str], bool] = {}

    def prompt(self, message: str | None = None) -> str:
        with patch_stdout(raw=True):
            if message is not None:
                if self._question_session is None:
                    self._question_session = self._create_question_session()
                return self._question_session.prompt(
                    message=[("class:question", message)]
                )
            if self._session is None:
                self._session = self._create_session()
            return self._session.prompt()

    def _create_question_session(self) -> Any:
        return self._session_factory(
            multiline=False,
            history=DummyHistory(),
            style=Style.from_dict({"question": "bold ansicyan"}),
        )

    def prompt_secret(self, message: str) -> str:
        with patch_stdout(raw=True):
            if self._secret_session is None:
                self._secret_session = self._session_factory(
                    multiline=False,
                    history=DummyHistory(),
                    is_password=True,
                    style=Style.from_dict({"question": "bold ansicyan"}),
                )
            return self._secret_session.prompt(
                message=[("class:question", message)]
            )

    def _create_session(self) -> Any:
        return self._session_factory(
            message=self._input_prompt,
            multiline=True,
            show_frame=True,
            prompt_continuation=HTML("<input-padding>  </input-padding>"),
            history=InMemoryHistory(),
            # PromptSession disables complete_while_typing whenever history
            # search is enabled. Ordinary Up/Down history navigation remains
            # available without this prefix-search mode.
            enable_history_search=False,
            auto_suggest=AutoSuggestFromHistory(),
            key_bindings=_input_bindings(
                is_running=self._is_running,
                cancel=self._cancel_from_keybinding,
                notify=self.write,
            ),
            completer=(
                CommandCompleter(
                    self.command_registry,
                    state_fn=lambda: (
                        self.state.session_state
                        if not self._is_running()
                        else "RUNNING_MODEL"
                    ),
                )
                if self.command_registry is not None
                else None
            ),
            # Keep Pi-style command hints live only while the input is a slash
            # command. Limiting the filter also keeps the framed editor compact
            # for ordinary messages instead of reserving menu rows constantly.
            complete_while_typing=Condition(self._slash_completion_context),
            reserve_space_for_menu=6,
            style=Style.from_dict(
                {
                    "frame.border": "#9b6aa0",
                    "input-padding": "",
                    "prompt": "bold ansicyan",
                    "completion-menu.completion": "bg:#191d27 #d0d7e2",
                    "completion-menu.completion.current": "bg:#69456f #ffffff",
                    "completion-menu.meta.completion": "bg:#191d27 #8993a4",
                    "completion-menu.meta.completion.current": "bg:#69456f #ffffff",
                }
            ),
        )

    def _slash_completion_context(self) -> bool:
        session = self._session
        if self.command_registry is None or session is None:
            return False
        buffer = getattr(session, "default_buffer", None)
        text = str(getattr(buffer, "text", ""))
        return text.startswith("/") and "\n" not in text

    def set_command_registry(self, registry: CommandRegistry) -> None:
        self.command_registry = registry
        self._session = None

    def set_cancel_callback(self, callback: Callable[[], None]) -> None:
        self.cancel_callback = callback

    def set_runtime_running_callback(self, callback: Callable[[], bool]) -> None:
        self.runtime_running_callback = callback

    def _is_running(self) -> bool:
        if self.runtime_running_callback is not None:
            return bool(self.runtime_running_callback())
        return self.state.session_state in {
            "RUNNING_MODEL",
            "RUNNING_TOOL",
            "RUNNING_TOOLS",
            "CANCELLING",
        }

    def _cancel_from_keybinding(self) -> None:
        if self.state.session_state == "CANCELLING":
            self.write("Cancelling…")
            return
        if self.cancel_callback is not None:
            self.cancel_callback()

    def _input_prompt(self) -> HTML:
        return HTML("<prompt>❯ </prompt>")

    def start_event_renderer(self) -> None:
        if self._renderer_closed or self._event_thread is not None:
            return
        self._event_stop.clear()
        self._event_thread = threading.Thread(
            target=self._event_loop,
            name="laohuang-terminal-renderer",
            daemon=True,
        )
        self._event_thread.start()

    def stop_event_renderer(self) -> None:
        thread = self._event_thread
        if thread is None:
            return
        self._renderer_closed = True
        self._event_stop.set()
        try:
            self._event_queue.put(None, timeout=2)
        except Full:
            pass
        thread.join(timeout=2)
        self._event_thread = None

    def publish_event(self, event: Any) -> None:
        """Queue a projected event; the renderer thread is the sole event writer."""
        if self._renderer_closed or _is_hidden_tool_stdout(event):
            return
        self.start_event_renderer()
        kind = str(event.get("kind", "")) if isinstance(event, dict) else ""
        high_frequency = kind in {
            "model.reasoning_delta",
            "model.tool_call_delta",
            "tool.output_delta",
        }
        if high_frequency and self._event_queue.qsize() >= 3_968:
            return
        try:
            self._event_queue.put_nowait(event)
        except Full:
            if not high_frequency:
                self._event_queue.put(event)

    def _event_loop(self) -> None:
        while not self._event_stop.is_set() or not self._event_queue.empty():
            try:
                event = self._event_queue.get(timeout=0.05)
            except Empty:
                continue
            if event is None:
                self._event_queue.task_done()
                continue
            try:
                try:
                    self._render_event(event)
                except Exception as error:
                    self._render_error = error
            finally:
                self._event_queue.task_done()

    def _render_event(self, event: Any) -> None:
        if isinstance(event, _LocalMessage):
            with self._render_lock:
                self.console.print(Text(event.text, style=event.style))
            self._invalidate_prompt()
            return
        payload = event.get("payload", {}) if isinstance(event, dict) else {}
        dropped = (
            int(payload.get("_projection_dropped", 0) or 0)
            if isinstance(payload, dict)
            else 0
        )
        if dropped:
            with self._render_lock:
                if self._streaming_response:
                    self.console.print()
                self.console.print(
                    Text(
                        f"… 省略了 {dropped} 个流式展示事件；Agent 仍继续运行。",
                        style="yellow",
                    )
                )
            self._streaming_response = False
        update = self.reducer.apply(event)
        if update is None:
            return
        with self._render_lock:
            self._render_update(update)
        self._invalidate_prompt()

    def _invalidate_prompt(self) -> None:
        app = getattr(self._session, "app", None)
        invalidate = getattr(app, "invalidate", None)
        if callable(invalidate):
            invalidate()

    def _render_update(self, update: UIUpdate) -> None:
        if update.kind == "ui.message":
            self.console.print(
                Text(update.text, style=str(update.payload.get("style", "")))
            )
            return
        if update.kind == "model.text_delta":
            self.console.print(Text(update.text), end="")
            self._streaming_response = True
            return
        if update.kind == "model.response_committed":
            if self._streaming_response:
                self.console.print()
            self._streaming_response = False
            return
        if update.kind in {"model.response_aborted", "model.request_failed"}:
            if self._streaming_response:
                self.console.print()
                self.console.print(
                    Text("响应中断，未加入上下文。", style="yellow")
                )
            self._streaming_response = False
            return
        if update.kind == "tool.started":
            name = str(update.payload.get("name", "tool"))
            arguments = update.payload.get("arguments", {})
            subject = ""
            if isinstance(arguments, dict):
                subject = str(arguments.get("command") or arguments.get("path") or "")
            short_id = update.correlation_id[-8:] or "unknown"
            self.console.print(
                Text(f"● {name} [{short_id}]  {self._clip(subject, 180)}", style="cyan")
            )
            return
        if update.kind == "tool.output_delta":
            self._render_tool_delta(update, "yellow")
            return
        if update.kind == "tool.finished":
            short_id = update.correlation_id[-8:] or "unknown"
            status = str(update.payload.get("status", "completed"))
            exit_code = update.payload.get("exit_code")
            duration = update.payload.get("duration_ms")
            detail = f" · exit {exit_code}" if exit_code is not None else ""
            if duration is not None:
                detail += f" · {duration}ms"
            style = "green" if status == "completed" else "yellow"
            self.console.print(Text(f"✓ [{short_id}] {status}{detail}", style=style))
            self._tool_line_start.pop(
                (update.correlation_id, "stdout"), None
            )
            self._tool_line_start.pop(
                (update.correlation_id, "stderr"), None
            )
            return
        if update.kind == "task.cancelled":
            self.console.print(
                Text(
                    "任务已取消；已经完成的文件修改不会自动撤销。",
                    style="yellow",
                )
            )
        elif update.kind == "task.failed":
            self.show_error(str(update.payload.get("error", "Task failed")))

    def _render_tool_delta(self, update: UIUpdate, style: str) -> None:
        key = (update.correlation_id, update.stream)
        at_line_start = self._tool_line_start.get(key, True)
        short_id = update.correlation_id[-8:] or "unknown"
        for part in update.text.splitlines(keepends=True) or [update.text]:
            prefix = f"  [{short_id}:{update.stream}] " if at_line_start else ""
            self.console.print(Text(prefix + part, style=style), end="")
            at_line_start = part.endswith(("\n", "\r"))
        self._tool_line_start[key] = at_line_start

    def flush_event_renderer(self) -> None:
        if self._event_thread is not None:
            self._event_queue.join()

    def show_assistant(self, response: str) -> None:
        self.console.print()
        self.console.print(Markdown(response))

    def show_welcome(self) -> None:
        details = Text()
        if self.project_root is not None:
            details.append("project  ", style="dim")
            details.append(str(self.project_root))
        if self.provider and self.model:
            if details:
                details.append("\n")
            details.append("model    ", style="dim")
            details.append(f"{self.provider} / {self.model}")
        if self.dashboard_url:
            if details:
                details.append("\n")
            details.append("trace    ", style="dim")
            details.append(self.dashboard_url, style="cyan underline")
        self.console.print(
            Panel(
                details,
                title="[bold cyan]laoHuangCode[/]",
                subtitle="[dim]/help 查看命令 · /exit 退出[/]",
                border_style="cyan",
                padding=(0, 1),
            )
        )

    def write(self, message: str) -> None:
        self._write_local(message)

    def show_error(self, message: str) -> None:
        self._write_local(f"Error: {message}", "bold red")

    def show_interrupted(self, *, operation: bool = False) -> None:
        message = "Operation interrupted." if operation else "Interrupted."
        self._write_local(message, "yellow")

    def show_goodbye(self) -> None:
        self.console.print("[dim]Goodbye.[/]")

    def _write_local(self, message: str, style: str = "") -> None:
        renderer = self._event_thread
        if renderer is not None and threading.current_thread() is not renderer:
            self.publish_event(_LocalMessage(message, style))
            return
        with self._render_lock:
            self.console.print(Text(message, style=style))

    def thinking(self) -> Any:
        return self.console.status(
            "[cyan]Thinking…[/]", spinner="dots", spinner_style="cyan"
        )

    def show_tool(
        self,
        name: str,
        arguments: dict[str, Any],
        result: dict[str, Any],
    ) -> None:
        subject = arguments.get("command") if name == "bash" else arguments.get("path")
        heading = Text()
        heading.append("● ", style="bold green")
        heading.append(name, style="bold cyan")
        if isinstance(subject, str) and subject:
            heading.append("  ", style="dim")
            heading.append(self._clip(subject, 180), style="dim")
        self.console.print(heading)

        if not result.get("ok"):
            detail = f"失败 · {result.get('error', 'unknown error')}"
            self.console.print(
                Text(f"  └─ {self._clip(detail, 1_000)}", style="red")
            )
            return

        if name == "bash":
            self.console.print(
                Text(f"  └─ exit {result.get('exit_code', 0)}", style="dim")
            )
            stderr = result.get("stderr")
            if isinstance(stderr, str) and stderr.strip():
                self.console.print(
                    Text(self._clip(stderr.strip(), 1_200), style="yellow")
                )
            return

        content = result.get("content")
        if isinstance(content, str):
            detail = self._clip(content, 1_200)
        else:
            detail = json.dumps(result, ensure_ascii=False)
        self.console.print(Text(f"  └─ {detail}", style="dim"))

    @staticmethod
    def _clip(value: str, limit: int) -> str:
        if len(value) <= limit:
            return value
        return value[:limit] + "…"


def _is_hidden_tool_stdout(event: Any) -> bool:
    """Keep captured tool stdout out of user-facing terminal render queues."""
    if not isinstance(event, dict):
        return False
    if str(event.get("kind", "")) != "tool.output_delta":
        return False
    payload = event.get("payload", {})
    return (
        isinstance(payload, dict)
        and payload.get("stream", "stdout") == "stdout"
    )
