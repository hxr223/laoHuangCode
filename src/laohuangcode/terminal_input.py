"""A compact Pi-style prompt_toolkit editor with horizontal borders only."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from threading import Event, Lock
from typing import Any

from prompt_toolkit.application import Application
from prompt_toolkit.buffer import Buffer
from prompt_toolkit.filters import Condition, has_completions
from prompt_toolkit.formatted_text import AnyFormattedText
from prompt_toolkit.history import History, InMemoryHistory
from prompt_toolkit.key_binding import KeyBindings, KeyBindingsBase
from prompt_toolkit.layout import Dimension, Layout
from prompt_toolkit.layout.containers import ConditionalContainer, HSplit, Window
from prompt_toolkit.layout.controls import BufferControl, FormattedTextControl
from prompt_toolkit.layout.menus import CompletionsMenu
from prompt_toolkit.layout.processors import ConditionalProcessor, PasswordProcessor
from prompt_toolkit.styles import BaseStyle, Style
from prompt_toolkit.utils import get_cwidth


class PiInputSession:
    """Small ``PromptSession``-compatible adapter for the task editor.

    Prompt Toolkit's built-in ``show_frame`` draws vertical box edges. Pi's
    editor has only top and bottom rules, so this adapter owns a tiny layout
    and keeps the same ``prompt()`` / ``default_buffer`` surface used by the
    CLI and terminal renderer.
    """

    def __init__(
        self,
        message: AnyFormattedText = "",
        *,
        multiline: bool = True,
        history: History | None = None,
        style: BaseStyle | None = None,
        key_bindings: KeyBindingsBase | None = None,
        completer: Any | None = None,
        complete_while_typing: Any = False,
        auto_suggest: Any | None = None,
        enable_history_search: Any = False,
        reserve_space_for_menu: int = 6,
        erase_when_done: bool = True,
        input: Any | None = None,
        output: Any | None = None,
        footer: Callable[[], AnyFormattedText] | None = None,
        **_ignored: Any,
    ) -> None:
        self.message = message
        self.multiline = multiline
        self.history = history or InMemoryHistory()
        self.style = style or Style.from_dict({})
        self.key_bindings = key_bindings or self._default_key_bindings()
        self.completer = completer
        self.complete_while_typing = complete_while_typing
        self.auto_suggest = auto_suggest
        self.enable_history_search = enable_history_search
        self.reserve_space_for_menu = reserve_space_for_menu
        self.erase_when_done = erase_when_done
        self.input = input
        self.output = output
        self.footer = footer
        self.app: Application[str] | None = None
        self.default_buffer = Buffer(
            completer=self.completer,
            auto_suggest=self.auto_suggest,
            history=self.history,
            complete_while_typing=self.complete_while_typing,
            enable_history_search=self.enable_history_search,
            multiline=self.multiline,
            accept_handler=self._accept,
        )

    def _accept(self, buffer: Buffer) -> bool:
        if self.app is not None:
            self.app.exit(result=buffer.text)
        return True

    @staticmethod
    def _default_key_bindings() -> KeyBindings:
        bindings = KeyBindings()

        @bindings.add("enter")
        def submit(event: Any) -> None:
            event.current_buffer.validate_and_handle()

        return bindings

    def prompt(self, **_kwargs: Any) -> str:
        self.default_buffer.reset()
        control = BufferControl(buffer=self.default_buffer, focusable=True)
        editor = Window(
            content=control,
            height=Dimension(min=1, max=10),
            wrap_lines=True,
            get_line_prefix=self._line_prefix,
        )
        border = Window(height=1, char="─", style="class:frame.border")
        menu = ConditionalContainer(
            CompletionsMenu(max_height=self.reserve_space_for_menu),
            filter=has_completions,
        )
        children: list[Any] = [border, editor, border, menu]
        if self.footer is not None:
            children.append(
                Window(
                    content=FormattedTextControl(self.footer),
                    height=Dimension(min=1, max=2),
                    style="class:footer",
                )
            )
        layout = Layout(HSplit(children), focused_element=control)
        self.app = Application(
            layout=layout,
            key_bindings=self.key_bindings,
            style=self.style,
            full_screen=False,
            erase_when_done=self.erase_when_done,
            input=self.input,
            output=self.output,
        )
        return self.app.run()

    @staticmethod
    def _line_prefix(line_number: int, wrap_count: int) -> AnyFormattedText:
        if line_number == 0 and wrap_count == 0:
            return [("class:prompt", "❯ ")]
        return [("class:input-padding", "  ")]


@dataclass(slots=True)
class _Question:
    message: str
    secret: bool
    answered: Event
    answer: str = ""


class PiTerminalApplication:
    """One long-lived prompt_toolkit application for an agent session.

    This is deliberately different from :class:`PiInputSession`: the latter
    is a small, one-shot editor used by setup questions and tests.  A running
    coding session must have exactly one terminal renderer, so this class owns
    both the transcript and the editor for its whole lifetime.  Other threads
    may update transcript state and call :meth:`invalidate`, but never write
    terminal bytes themselves.
    """

    def __init__(
        self,
        *,
        history: History | None = None,
        style: BaseStyle | None = None,
        key_bindings: KeyBindingsBase | None = None,
        completer: Any | None = None,
        complete_while_typing: Any = False,
        auto_suggest: Any | None = None,
        enable_history_search: Any = False,
        reserve_space_for_menu: int = 6,
        transcript: Callable[[int, int], AnyFormattedText],
        footer: Callable[[], AnyFormattedText] | None = None,
        input: Any | None = None,
        output: Any | None = None,
    ) -> None:
        self.history = history or InMemoryHistory()
        self.style = style or Style.from_dict({})
        self.key_bindings = key_bindings or PiInputSession._default_key_bindings()
        self.completer = completer
        self.complete_while_typing = complete_while_typing
        self.auto_suggest = auto_suggest
        self.enable_history_search = enable_history_search
        self.reserve_space_for_menu = reserve_space_for_menu
        self._transcript = transcript
        self._footer = footer
        self.input = input
        self.output = output
        self.app: Application[None] | None = None
        self._submit: Callable[[str], None] | None = None
        self._running = Event()
        self._lock = Lock()
        self._question: _Question | None = None
        self._exit_requested = False
        self.default_buffer = Buffer(
            completer=self.completer,
            auto_suggest=self.auto_suggest,
            history=self.history,
            complete_while_typing=self.complete_while_typing,
            enable_history_search=self.enable_history_search,
            multiline=True,
            accept_handler=self._accept,
        )

    @property
    def running(self) -> bool:
        return self._running.is_set()

    def _accept(self, buffer: Buffer) -> bool:
        text = buffer.text.strip()
        with self._lock:
            question = self._question
            if question is not None:
                question.answer = text
                self._question = None
        if question is not None:
            question.answered.set()
            buffer.reset()
            self.invalidate()
            return True
        if text and self._submit is not None:
            self._submit(text)
        buffer.reset()
        return True

    def run(self, on_submit: Callable[[str], None]) -> None:
        """Run the UI until its key bindings request exit.

        The caller's submit handler must return quickly (normally it enqueues
        text for the session coordinator).  Keeping it non-blocking prevents
        a semantic-routing network call from freezing redraws.
        """

        self._submit = on_submit
        transcript_window = Window(
            content=FormattedTextControl(self._render_transcript),
            wrap_lines=False,
            always_hide_cursor=True,
            height=self._transcript_height,
        )
        control = BufferControl(buffer=self.default_buffer, focusable=True)
        control.input_processors = [
            ConditionalProcessor(
                PasswordProcessor(),
                Condition(lambda: self._question_is_secret()),
            )
        ]
        editor = Window(
            content=control,
            height=self._editor_height,
            wrap_lines=True,
            get_line_prefix=self._line_prefix,
        )
        border = Window(height=1, char="─", style="class:frame.border")
        menu = CompletionsMenu(max_height=self.reserve_space_for_menu)
        # CompletionsMenu normally exposes a min..max range.  In a regular
        # terminal layout that lets HSplit spend spare terminal rows on the
        # menu's selection background.  Its height must be the exact number
        # of visible candidates instead.
        menu.content.height = self._completion_height
        children: list[Any] = [transcript_window, border, editor, border, menu]
        if self._footer is not None:
            children.append(
                Window(
                    content=FormattedTextControl(self._footer),
                    height=self._footer_height,
                    style="class:footer",
                )
            )
        layout = Layout(HSplit(children), focused_element=control)
        app: Application[None] = Application(
            layout=layout,
            key_bindings=self.key_bindings,
            style=self.style,
            full_screen=False,
            erase_when_done=True,
            input=self.input,
            output=self.output,
        )
        with self._lock:
            self.app = app
            self._exit_requested = False
        self._running.set()
        try:
            app.run()
        finally:
            self._running.clear()
            with self._lock:
                self.app = None
                question = self._question
                self._question = None
            if question is not None:
                question.answered.set()

    def _render_transcript(self) -> AnyFormattedText:
        app = self.app
        if app is None:
            return []
        size = app.output.get_size()
        return self._transcript(size.columns, size.rows)

    @staticmethod
    def _formatted_height(formatted: AnyFormattedText) -> int:
        """Return the occupied rows in prompt_toolkit formatted text."""

        text = "".join(fragment for _style, fragment in formatted)
        if not text:
            return 0
        return text.count("\n") + (0 if text.endswith("\n") else 1)

    def _output_size(self) -> tuple[int, int]:
        with self._lock:
            app = self.app
        if app is None:
            return 80, 24
        size = app.output.get_size()
        return max(12, size.columns), max(1, size.rows)

    def _completion_rows(self) -> int:
        state = self.default_buffer.complete_state
        if state is None or not state.completions:
            return 0
        return min(len(state.completions), self.reserve_space_for_menu)

    def _editor_rows(self) -> int:
        columns, _rows = self._output_size()
        first_prefix = sum(
            get_cwidth(fragment)
            for _style, fragment in self._line_prefix(0, 0)
        )
        continuation_prefix = sum(
            get_cwidth(fragment)
            for _style, fragment in self._line_prefix(1, 0)
        )
        total = 0
        for index, line in enumerate(self.default_buffer.text.split("\n")):
            prefix = first_prefix if index == 0 else continuation_prefix
            available = max(1, columns - prefix)
            width = get_cwidth(line)
            total += max(1, (width + available - 1) // available)
        return min(10, max(1, total))

    def _footer_rows(self) -> int:
        if self._footer is None:
            return 0
        return min(2, self._formatted_height(self._footer()))

    def _transcript_rows(self) -> int:
        columns, rows = self._output_size()
        fixed_rows = (
            self._editor_rows()
            + self._completion_rows()
            + self._footer_rows()
            + 2  # The editor's horizontal rules.
        )
        available = max(0, rows - fixed_rows)
        transcript = self._transcript(columns, rows)
        return min(self._formatted_height(transcript), available)

    def _transcript_height(self) -> Dimension:
        return Dimension.exact(self._transcript_rows())

    def _editor_height(self) -> Dimension:
        return Dimension.exact(self._editor_rows())

    def _completion_height(self) -> Dimension:
        return Dimension.exact(self._completion_rows())

    def _footer_height(self) -> Dimension:
        return Dimension.exact(self._footer_rows())

    def invalidate(self) -> None:
        with self._lock:
            app = self.app
        if app is not None and self.running:
            app.invalidate()

    def ask(self, message: str, *, secret: bool = False) -> str:
        """Use the session editor for a command follow-up question.

        The calling command coordinator blocks on the event, while the UI
        event loop remains free to render and accept the answer.  This avoids
        nesting a second PromptSession inside the live terminal application.
        """

        question = _Question(message, secret, Event())
        with self._lock:
            if self.app is None or not self._running.is_set():
                return ""
            self._question = question
        self.invalidate()
        question.answered.wait()
        return question.answer

    def _question_is_secret(self) -> bool:
        with self._lock:
            return bool(self._question and self._question.secret)

    def _line_prefix(self, line_number: int, wrap_count: int) -> AnyFormattedText:
        if line_number != 0 or wrap_count != 0:
            return [("class:input-padding", "  ")]
        with self._lock:
            question = self._question
        if question is not None:
            return [("class:prompt", f"{question.message} ")]
        return [("class:prompt", "❯ ")]

    def exit(self) -> None:
        with self._lock:
            app = self.app
            question = self._question
            if question is not None:
                self._question = None
                question.answered.set()
            if app is None or not self.running or self._exit_requested:
                return
            self._exit_requested = True
        if getattr(app, "is_done", False):
            return
        loop = getattr(app, "loop", None)
        if loop is not None:
            loop.call_soon_threadsafe(app.exit)
        else:
            app.exit()
