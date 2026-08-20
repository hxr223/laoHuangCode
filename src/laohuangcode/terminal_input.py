"""A compact Pi-style prompt_toolkit editor with horizontal borders only."""

from __future__ import annotations

from collections.abc import Callable
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
from prompt_toolkit.styles import BaseStyle, Style


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
