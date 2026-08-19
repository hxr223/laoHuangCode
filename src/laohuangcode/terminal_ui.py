"""Polished interactive terminal UI for laoHuangCode."""

from __future__ import annotations

from collections.abc import Callable
import json
from pathlib import Path
from typing import Any

from prompt_toolkit import PromptSession
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.formatted_text import HTML
from prompt_toolkit.history import DummyHistory, InMemoryHistory
from prompt_toolkit.key_binding import KeyBindings
from prompt_toolkit.styles import Style
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.text import Text


def _input_bindings() -> KeyBindings:
    bindings = KeyBindings()

    @bindings.add("enter")
    def submit(event: Any) -> None:
        event.current_buffer.validate_and_handle()

    @bindings.add("escape", "enter")
    def insert_newline(event: Any) -> None:
        event.current_buffer.insert_text("\n")

    return bindings


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
    ) -> None:
        self.console = console or Console()
        self._session_factory = session_factory
        self._session: Any | None = None
        self._question_session: Any | None = None
        self.project_root = project_root
        self.provider = provider
        self.model = model
        self.dashboard_url = dashboard_url

    def prompt(self, message: str | None = None) -> str:
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

    def _create_session(self) -> Any:
        return self._session_factory(
            message=HTML("<prompt>❯ </prompt>"),
            multiline=True,
            prompt_continuation=HTML("<continuation>│ </continuation>"),
            bottom_toolbar=HTML(
                "<toolbar> Enter 发送 · Alt+Enter 换行 · ↑/↓ 历史 · Ctrl+D 退出 </toolbar>"
            ),
            history=InMemoryHistory(),
            enable_history_search=True,
            auto_suggest=AutoSuggestFromHistory(),
            key_bindings=_input_bindings(),
            style=Style.from_dict(
                {
                    "prompt": "bold ansicyan",
                    "continuation": "ansibrightblack",
                    "toolbar": "bg:#1f2937 #d1d5db",
                }
            ),
        )

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
        self.console.print(Text(message))

    def show_error(self, message: str) -> None:
        error = Text("Error: ", style="bold red")
        error.append(message)
        self.console.print(error)

    def show_interrupted(self, *, operation: bool = False) -> None:
        message = "Operation interrupted." if operation else "Interrupted."
        self.console.print(f"[yellow]{message}[/]")

    def show_goodbye(self) -> None:
        self.console.print("[dim]Goodbye.[/]")

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
            stdout = result.get("stdout")
            stderr = result.get("stderr")
            if isinstance(stdout, str) and stdout.strip():
                self.console.print(Text(self._clip(stdout.strip(), 1_200), style="dim"))
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
