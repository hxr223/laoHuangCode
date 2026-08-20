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
from prompt_toolkit.utils import get_cwidth
from rich.console import Console
from rich.markdown import Markdown
from rich.padding import Padding
from rich.panel import Panel
from rich.text import Text

from .commands import CommandCompleter, CommandRegistry
from .terminal_input import PiInputSession, PiTerminalApplication
from .terminal_markdown import render_markdown
from .terminal_theme import TerminalTheme, resolve_terminal_theme
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


@dataclass(slots=True)
class _TranscriptItem:
    """A stable piece of the single-renderer terminal transcript."""

    kind: str
    text: str = ""
    correlation_id: str = ""
    name: str = ""
    subject: str = ""
    status: str = ""
    exit_code: int | None = None
    duration_ms: int | None = None
    stream_error: str = ""
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
        session_factory: Callable[..., Any] | None = None,
        project_root: Path | None = None,
        provider: str | None = None,
        model: str | None = None,
        dashboard_url: str | None = None,
        command_registry: CommandRegistry | None = None,
        cancel_callback: Callable[[], None] | None = None,
        theme: str | None = None,
    ) -> None:
        self.console = console or Console()
        self._session_factory = session_factory or PiInputSession
        self._question_session_factory = session_factory or PromptSession
        self._uses_pi_input = session_factory is None
        self._session: Any | None = None
        self._question_session: Any | None = None
        self._secret_session: Any | None = None
        self.project_root = project_root
        self.provider = provider
        self.model = model
        self.dashboard_url = dashboard_url
        self.command_registry = command_registry
        self.cancel_callback = cancel_callback
        self.theme: TerminalTheme = resolve_terminal_theme(theme)
        # Production interactive sessions use one persistent prompt_toolkit
        # application.  Supplying a Console or custom session factory remains
        # a small legacy/testing escape hatch and keeps setup prompts simple.
        self._single_renderer = console is None and session_factory is None
        self._terminal_app: PiTerminalApplication | None = None
        self._transcript: list[_TranscriptItem] = []
        self._transcript_by_correlation: dict[tuple[str, str], _TranscriptItem] = {}
        self._transcript_lock = threading.RLock()
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
        self._streaming_thinking = False
        self._tool_line_start: dict[tuple[str, str], bool] = {}

    def prompt(self, message: str | None = None) -> str:
        if self._terminal_app is not None and self._terminal_app.running:
            return self._terminal_app.ask(message or "Input:")
        with patch_stdout(raw=True):
            if message is not None:
                if self._question_session is None:
                    self._question_session = self._create_question_session()
                return self._question_session.prompt(
                    message=[("class:question", message)]
                )
            if self._session is None:
                self._session = self._create_session()
            response = self._session.prompt()
            submitted = response.strip()
            if submitted:
                self._echo_submitted_input(submitted)
            return response

    def run(self, on_submit: Callable[[str], None]) -> None:
        """Run the single-owner interactive terminal for the whole session.

        ``on_submit`` is intentionally a queueing callback owned by the CLI;
        it must not synchronously call the semantic router from the UI loop.
        """

        if not self._single_renderer:
            raise RuntimeError("single-renderer mode is unavailable for this UI")
        if self._terminal_app is None:
            self._terminal_app = PiTerminalApplication(
                history=InMemoryHistory(),
                style=self.theme.prompt_style(),
                key_bindings=_input_bindings(
                    is_running=self._is_running,
                    cancel=self._cancel_from_keybinding,
                    notify=self.write,
                ),
                completer=self._command_completer(),
                complete_while_typing=Condition(self._slash_completion_context),
                auto_suggest=AutoSuggestFromHistory(),
                enable_history_search=False,
                reserve_space_for_menu=6,
                transcript=self._render_transcript,
                footer=self._footer_text,
            )

        def submit(text: str) -> None:
            self._append_transcript(_TranscriptItem("user", text=text))
            on_submit(text)

        self._terminal_app.run(submit)

    def request_exit(self) -> None:
        if self._terminal_app is not None:
            self._terminal_app.exit()

    def _command_completer(self) -> CommandCompleter | None:
        if self.command_registry is None:
            return None
        return CommandCompleter(
            self.command_registry,
            state_fn=lambda: (
                self.state.session_state
                if not self._is_running()
                else "RUNNING_MODEL"
            ),
        )

    def _append_transcript(self, item: _TranscriptItem) -> None:
        with self._transcript_lock:
            self._transcript.append(item)
            if item.correlation_id:
                self._transcript_by_correlation[(item.kind, item.correlation_id)] = item
            # Keep UI memory bounded.  Tool/model source data remains in the
            # agent history and Web trace; this is only the visible viewport.
            if len(self._transcript) > 800:
                removed = self._transcript[:200]
                del self._transcript[:200]
                for old in removed:
                    if old.correlation_id:
                        self._transcript_by_correlation.pop(
                            (old.kind, old.correlation_id), None
                        )
        self._invalidate_prompt()

    def _render_transcript(
        self, width: int, height: int
    ) -> list[tuple[str, str]]:
        """Render immutable transcript state; this is the sole UI writer."""

        usable_width = max(12, width)
        with self._transcript_lock:
            items = tuple(self._transcript)
        lines: list[tuple[str, str]] = []
        for item in items:
            lines.extend(self._render_transcript_item(item, usable_width))
        # Leave a small blank breathing area above the editor and show the
        # newest material when the transcript exceeds the available viewport.
        visible = max(1, height - 10)
        return lines[-visible:] if len(lines) > visible else lines

    def _render_transcript_item(
        self, item: _TranscriptItem, width: int
    ) -> list[tuple[str, str]]:
        if item.kind == "user":
            return self._background_lines(
                item.text,
                width,
                background="user_bg",
                foreground="text",
            )
        if item.kind == "assistant":
            return render_markdown(item.text, width, self.theme)
        if item.kind == "thinking":
            return self._plain_lines(
                f"thinking  {item.text}",
                width,
                f"italic {self.theme.color('thinking')}",
            )
        if item.kind == "tool":
            status = item.status or "running"
            is_running = status == "running"
            background = (
                "tool_pending_bg"
                if is_running
                else "tool_success_bg"
                if status == "completed"
                else "tool_error_bg"
            )
            accent = (
                "accent" if is_running else "success" if status == "completed" else "warning"
            )
            title = f"● {item.name or 'tool'}"
            if item.subject:
                title += f"  {self._clip(item.subject, 180)}"
            if item.correlation_id:
                title += f"  [{item.correlation_id[-8:]}]"
            detail = "Running…" if is_running else status
            if item.exit_code is not None:
                detail += f" · exit {item.exit_code}"
            if item.duration_ms is not None:
                detail += f" · {item.duration_ms}ms"
            if item.stream_error:
                detail += f"\n{self._clip(item.stream_error, 1_200)}"
            rendered = self._background_lines(
                f"{title}\n{detail}",
                width,
                background=background,
                foreground="text",
            )
            if rendered:
                first_style, first_text = rendered[0]
                rendered[0] = (
                    first_style.replace(self.theme.color("text"), self.theme.color(accent)),
                    first_text,
                )
            return rendered
        return self._plain_lines(item.text, width, item.style or self.theme.color("text"))

    def _background_lines(
        self,
        text: str,
        width: int,
        *,
        background: str,
        foreground: str,
    ) -> list[tuple[str, str]]:
        style = f"bg:{self.theme.color(background)} {self.theme.color(foreground)}"
        return [
            (style, self._pad_line(line, width) + "\n")
            for line in self._wrap_lines(text, width)
        ]

    def _plain_lines(
        self, text: str, width: int, style: str
    ) -> list[tuple[str, str]]:
        return [(style, line + "\n") for line in self._wrap_lines(text, width)]

    @staticmethod
    def _wrap_lines(text: str, width: int) -> list[str]:
        result: list[str] = []
        for source_line in text.splitlines() or [""]:
            line = ""
            line_width = 0
            for char in source_line:
                char_width = max(1, get_cwidth(char))
                if line and line_width + char_width > width:
                    result.append(line)
                    line = ""
                    line_width = 0
                line += char
                line_width += char_width
            result.append(line)
        return result

    @staticmethod
    def _pad_line(line: str, width: int) -> str:
        return line + " " * max(0, width - get_cwidth(line))

    def _echo_submitted_input(self, text: str) -> None:
        """Retain accepted input after PromptSession erases its editor frame."""
        if self._single_renderer and self._terminal_app is not None:
            self._append_transcript(_TranscriptItem("user", text=text))
            return
        with self._render_lock:
            # A user may submit the next message while the prior model response
            # is streaming. Finish that visual line before recording the input.
            if self._streaming_response:
                self.console.print()
                self._streaming_response = False
            self.console.print(
                Padding(
                    Markdown(text),
                    (0, 1),
                    style=(
                        f"on {self.theme.color('user_bg')} "
                        f"{self.theme.color('text')}"
                    ),
                    expand=False,
                )
            )

    def _create_question_session(self) -> Any:
        return self._question_session_factory(
            multiline=False,
            history=DummyHistory(),
            style=Style.from_dict(
                {"question": f"bold {self.theme.color('accent')}"}
            ),
        )

    def prompt_secret(self, message: str) -> str:
        if self._terminal_app is not None and self._terminal_app.running:
            return self._terminal_app.ask(message, secret=True)
        with patch_stdout(raw=True):
            if self._secret_session is None:
                self._secret_session = self._question_session_factory(
                    multiline=False,
                    history=DummyHistory(),
                    is_password=True,
                    style=Style.from_dict(
                        {"question": f"bold {self.theme.color('accent')}"}
                    ),
                )
            return self._secret_session.prompt(
                message=[("class:question", message)]
            )

    def _create_session(self) -> Any:
        options: dict[str, Any] = {
            "message": self._input_prompt,
            "multiline": True,
            "show_frame": True,
            # Keep the frame as an affordance while typing, then erase it on
            # submit. ``_echo_submitted_input`` records the accepted message
            # as ordinary transcript text instead of a stack of empty frames.
            "erase_when_done": True,
            "prompt_continuation": HTML("<input-padding>  </input-padding>"),
            "history": InMemoryHistory(),
            # PromptSession disables complete_while_typing whenever history
            # search is enabled. Ordinary Up/Down history navigation remains
            # available without this prefix-search mode.
            "enable_history_search": False,
            "auto_suggest": AutoSuggestFromHistory(),
            "key_bindings": _input_bindings(
                is_running=self._is_running,
                cancel=self._cancel_from_keybinding,
                notify=self.write,
            ),
            "completer": self._command_completer(),
            # Keep Pi-style command hints live only while the input is a slash
            # command. Limiting the filter also keeps the framed editor compact
            # for ordinary messages instead of reserving menu rows constantly.
            "complete_while_typing": Condition(self._slash_completion_context),
            "reserve_space_for_menu": 6,
            "style": self.theme.prompt_style(),
        }
        if self._uses_pi_input:
            options["footer"] = self._footer_text
        return self._session_factory(**options)

    def _footer_text(self) -> list[tuple[str, str]]:
        details: list[str] = []
        if self.project_root is not None:
            details.append(str(self.project_root))
        if self.state.pending_count or self.state.held_count:
            details.append(
                f"queue {self.state.pending_count} pending / {self.state.held_count} held"
            )
        if self.state.total_tokens:
            details.append(
                f"↑{self.state.input_tokens} ↓{self.state.output_tokens}"
            )
        model = self.state.model or self.model
        if model:
            provider = self.state.provider or self.provider
            details.append(f"{provider}/{model}" if provider else model)
        return [("class:footer", " · ".join(details))]

    def _slash_completion_context(self) -> bool:
        session = self._terminal_app or self._session
        if self.command_registry is None or session is None:
            return False
        buffer = getattr(session, "default_buffer", None)
        text = str(getattr(buffer, "text", ""))
        return text.startswith("/") and "\n" not in text

    def set_command_registry(self, registry: CommandRegistry) -> None:
        self.command_registry = registry
        self._session = None
        # The persistent editor is created after commands are registered in
        # normal CLI startup.  Recreate it only if a caller changes the
        # registry before the UI is running.
        if self._terminal_app is not None and not self._terminal_app.running:
            self._terminal_app = None

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
            if self._single_renderer:
                self._append_transcript(
                    _TranscriptItem("notice", text=event.text, style=event.style)
                )
                return
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
            if self._single_renderer:
                self._append_transcript(
                    _TranscriptItem(
                        "notice",
                        text=f"… 省略了 {dropped} 个流式展示事件；Agent 仍继续运行。",
                        style="yellow",
                    )
                )
            else:
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
        if self._single_renderer:
            self._apply_transcript_update(update)
            self._invalidate_prompt()
            return
        with self._render_lock:
            self._render_update(update)
        self._invalidate_prompt()

    def _apply_transcript_update(self, update: UIUpdate) -> None:
        """Mutate UI state only; ``PiTerminalApplication`` paints it later."""

        kind = update.kind
        correlation_id = update.correlation_id
        if kind == "ui.message":
            self._append_transcript(
                _TranscriptItem(
                    "notice",
                    text=update.text,
                    style=str(update.payload.get("style", "")),
                )
            )
            return
        if kind == "model.text_delta":
            key = ("assistant", correlation_id)
            with self._transcript_lock:
                item = self._transcript_by_correlation.get(key)
                if item is None:
                    item = _TranscriptItem("assistant", correlation_id=correlation_id)
                    self._transcript.append(item)
                    self._transcript_by_correlation[key] = item
                item.text += update.text
            return
        if kind == "model.reasoning_delta":
            key = ("thinking", correlation_id)
            with self._transcript_lock:
                item = self._transcript_by_correlation.get(key)
                if item is None:
                    item = _TranscriptItem("thinking", correlation_id=correlation_id)
                    self._transcript.append(item)
                    self._transcript_by_correlation[key] = item
                item.text += update.text
            return
        if kind == "tool.started":
            arguments = update.payload.get("arguments", {})
            subject = ""
            if isinstance(arguments, dict):
                subject = str(arguments.get("command") or arguments.get("path") or "")
            item = _TranscriptItem(
                "tool",
                correlation_id=correlation_id,
                name=str(update.payload.get("name", "tool")),
                subject=subject,
                status="running",
            )
            self._append_transcript(item)
            return
        if kind == "tool.output_delta" and update.stream == "stderr":
            with self._transcript_lock:
                item = self._transcript_by_correlation.get(("tool", correlation_id))
                if item is not None:
                    item.stream_error = (item.stream_error + update.text)[-20_000:]
            return
        if kind == "tool.finished":
            with self._transcript_lock:
                item = self._transcript_by_correlation.get(("tool", correlation_id))
                if item is None:
                    item = _TranscriptItem("tool", correlation_id=correlation_id)
                    self._transcript.append(item)
                    self._transcript_by_correlation[("tool", correlation_id)] = item
                item.status = str(update.payload.get("status", "completed"))
                raw_exit_code = update.payload.get("exit_code")
                item.exit_code = raw_exit_code if isinstance(raw_exit_code, int) else None
                raw_duration = update.payload.get("duration_ms")
                item.duration_ms = raw_duration if isinstance(raw_duration, int) else None
            return
        if kind == "task.cancelled":
            self._append_transcript(
                _TranscriptItem("notice", text="任务已取消；已经完成的文件修改不会自动撤销。", style="yellow")
            )
            return
        if kind == "task.failed":
            self._append_transcript(
                _TranscriptItem(
                    "notice",
                    text=f"Error: {update.payload.get('error', 'Task failed')}",
                    style=f"bold {self.theme.color('error')}",
                )
            )

    def _invalidate_prompt(self) -> None:
        if self._terminal_app is not None:
            self._terminal_app.invalidate()
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
            if self._streaming_thinking:
                self.console.print()
                self._streaming_thinking = False
            self.console.print(Text(update.text), end="")
            self._streaming_response = True
            return
        if update.kind == "model.reasoning_delta":
            self.console.print(
                Text(update.text, style=f"italic {self.theme.color('thinking')}"),
                end="",
            )
            self._streaming_thinking = True
            return
        if update.kind == "model.response_committed":
            if self._streaming_response:
                self.console.print()
            self._streaming_response = False
            self._streaming_thinking = False
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
            self.console.print(self._tool_card(
                name=name,
                subject=subject,
                detail="Running…",
                background="tool_pending_bg",
                accent="accent",
                call_id=short_id,
            ))
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
            background = (
                "tool_success_bg" if status == "completed" else "tool_error_bg"
            )
            accent = "success" if status == "completed" else "warning"
            self.console.print(self._tool_card(
                name="tool",
                subject="",
                detail=f"{status}{detail}",
                background=background,
                accent=accent,
                call_id=short_id,
            ))
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
        if self._single_renderer:
            self._append_transcript(_TranscriptItem("assistant", text=response))
            return
        self.console.print()
        self.console.print(Markdown(response))

    def show_welcome(self) -> None:
        if self._single_renderer:
            details: list[str] = []
            if self.project_root is not None:
                details.append(str(self.project_root))
            if self.provider and self.model:
                details.append(f"{self.provider}/{self.model}")
            if self.dashboard_url:
                details.append(f"trace: {self.dashboard_url}")
            self._append_transcript(
                _TranscriptItem("notice", text="laoHuangCode  /help for commands", style=f"bold {self.theme.color('accent')}")
            )
            if details:
                self._append_transcript(
                    _TranscriptItem("notice", text=" · ".join(details), style=self.theme.color("dim"))
                )
            return
        heading = Text("laoHuangCode", style=f"bold {self.theme.color('accent')}")
        heading.append("  ", style="")
        heading.append("/help for commands", style=self.theme.color("dim"))
        self.console.print(heading)
        details: list[str] = []
        if self.project_root is not None:
            details.append(str(self.project_root))
        if self.provider and self.model:
            details.append(f"{self.provider}/{self.model}")
        if self.dashboard_url:
            details.append(f"trace: {self.dashboard_url}")
        if details:
            self.console.print(
                Text(" · ".join(details), style=self.theme.color("dim"))
            )

    def write(self, message: str) -> None:
        self._write_local(message)

    def show_error(self, message: str) -> None:
        self._write_local(
            f"Error: {message}", f"bold {self.theme.color('error')}"
        )

    def show_interrupted(self, *, operation: bool = False) -> None:
        message = "Operation interrupted." if operation else "Interrupted."
        self._write_local(message, self.theme.color("warning"))

    def show_goodbye(self) -> None:
        self.console.print(Text("Goodbye.", style=self.theme.color("dim")))

    def _tool_card(
        self,
        *,
        name: str,
        subject: str,
        detail: str,
        background: str,
        accent: str,
        call_id: str,
    ) -> Padding:
        heading = Text("● ", style=f"bold {self.theme.color(accent)}")
        heading.append(name, style=f"bold {self.theme.color('text')}")
        if subject:
            heading.append("  ")
            heading.append(self._clip(subject, 180), style=self.theme.color("muted"))
        heading.append(f"  [{call_id}]", style=self.theme.color("dim"))
        heading.append("\n")
        heading.append(detail, style=self.theme.color("muted"))
        return Padding(
            heading,
            (0, 1),
            style=(
                f"on {self.theme.color(background)} {self.theme.color('text')}"
            ),
            expand=False,
        )

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
