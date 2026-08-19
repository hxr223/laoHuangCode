"""Slash commands available inside an interactive agent session."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
import difflib
import shlex
from typing import Any, Protocol

from prompt_toolkit.completion import Completer, Completion

from .agent import CodingAgent
from .config import Config
from .credentials import CredentialStore
from .model_selection import ModelSelector
from .providers import get_provider, provider_names


class CommandHandler(Protocol):
    def __call__(self, arguments: list[str]) -> bool: ...


ArgumentCompleter = Callable[[tuple[str, ...]], Iterable[tuple[str, str]]]


@dataclass(frozen=True, slots=True)
class CommandSpec:
    """One source of truth for command help, completion, and dispatch."""

    name: str
    description: str
    usage: str
    handler: CommandHandler | None = None
    allowed_states: frozenset[str] = frozenset()
    argument_completer: ArgumentCompleter | None = None


class CommandRegistry:
    """Store slash commands without coupling prompt rendering to handlers."""

    def __init__(self, specs: Iterable[CommandSpec] = ()) -> None:
        self._specs: dict[str, CommandSpec] = {}
        for spec in specs:
            self.register(spec)

    def register(self, spec: CommandSpec) -> None:
        if not spec.name.startswith("/"):
            raise ValueError("Command names must start with '/'")
        self._specs[spec.name] = spec

    def get(self, name: str) -> CommandSpec | None:
        return self._specs.get(name)

    def all(self) -> tuple[CommandSpec, ...]:
        return tuple(self._specs[name] for name in sorted(self._specs))

    def suggest(self, name: str) -> str | None:
        matches = difflib.get_close_matches(name, self._specs, n=1, cutoff=0.55)
        return matches[0] if matches else None

    def dispatch(self, command: str, *, state: str | None = None) -> bool:
        try:
            parts = shlex.split(command)
        except ValueError:
            return False
        if not parts:
            return False
        spec = self.get(parts[0])
        if spec is None or spec.handler is None:
            return False
        if spec.allowed_states and state not in spec.allowed_states:
            return False
        return spec.handler(parts[1:])


class CommandCompleter(Completer):
    """Context-aware prompt_toolkit completer for slash commands."""

    def __init__(
        self,
        registry: CommandRegistry,
        *,
        state_fn: Callable[[], str] = lambda: "IDLE",
    ) -> None:
        self.registry = registry
        self.state_fn = state_fn

    def get_completions(self, document: Any, complete_event: Any) -> Iterable[Completion]:
        del complete_event
        text = document.text_before_cursor
        if not text.startswith("/") or "\n" in text:
            return

        if " " not in text:
            prefix = text
            for spec in self.registry.all():
                state = self.state_fn()
                unavailable = (
                    bool(spec.allowed_states)
                    and state not in spec.allowed_states
                    and spec.name != "/model"
                )
                if unavailable:
                    continue
                if spec.name.startswith(prefix):
                    yield Completion(
                        spec.name,
                        start_position=-len(prefix),
                        display_meta=spec.description,
                    )
            return

        command_name, raw_arguments = text.split(" ", 1)
        spec = self.registry.get(command_name)
        if spec is None or spec.argument_completer is None:
            return
        completed = tuple(raw_arguments.split())
        fragment = "" if raw_arguments.endswith(" ") else (completed[-1] if completed else "")
        fixed = completed if raw_arguments.endswith(" ") else completed[:-1]
        for value, description in spec.argument_completer(fixed):
            if (
                spec.allowed_states
                and self.state_fn() not in spec.allowed_states
                and not (spec.name == "/model" and value == "current")
            ):
                continue
            if value.startswith(fragment):
                yield Completion(
                    value,
                    start_position=-len(fragment),
                    display_meta=description,
                )


def _model_completions(arguments: tuple[str, ...]) -> Iterable[tuple[str, str]]:
    if not arguments:
        yield "current", "显示当前模型"
        for provider_name in provider_names():
            yield provider_name, "模型供应商"
        return
    if len(arguments) == 1:
        try:
            provider = get_provider(arguments[0])
        except ValueError:
            return
        for model in provider.suggested_models:
            yield model, f"{provider.name} 模型"


def _queue_completions(arguments: tuple[str, ...]) -> Iterable[tuple[str, str]]:
    if not arguments:
        yield "resume", "恢复保留的消息"
        yield "clear", "清空待处理和保留消息"


class SessionCommands:
    """Handle session-local model and credential commands."""

    def __init__(
        self,
        *,
        agent: CodingAgent,
        selector: ModelSelector,
        credentials: CredentialStore,
        current_config: Config,
        secret_input_fn: Callable[[str], str],
        output_fn: Callable[[str], None] = print,
        session: Any | None = None,
    ) -> None:
        self.agent = agent
        self.selector = selector
        self.credentials = credentials
        self.current_config = current_config
        self.secret_input_fn = secret_input_fn
        self.output_fn = output_fn
        self.session = session
        all_states = frozenset(
            {"IDLE", "RUNNING_MODEL", "RUNNING_TOOLS", "CANCELLING", "FAILED"}
        )
        idle_only = frozenset({"IDLE", "FAILED"})
        self.registry = CommandRegistry(
            (
                CommandSpec(
                    "/model",
                    "选择供应商和模型",
                    "/model [provider] [model]",
                    self._handle_model,
                    idle_only,
                    _model_completions,
                ),
                CommandSpec(
                    "/login",
                    "输入或更新API Key",
                    "/login [provider]",
                    self._handle_login,
                    idle_only,
                    lambda arguments: (
                        ((name, "模型供应商") for name in provider_names())
                        if not arguments
                        else ()
                    ),
                ),
                CommandSpec(
                    "/logout",
                    "删除保存的API Key",
                    "/logout [provider]",
                    self._handle_logout,
                    idle_only,
                    lambda arguments: (
                        ((name, "模型供应商") for name in provider_names())
                        if not arguments
                        else ()
                    ),
                ),
                CommandSpec(
                    "/apikey",
                    "管理API Key（兼容命令）",
                    "/apikey [set|remove] [provider]",
                    self._handle_api_key,
                    idle_only,
                ),
                CommandSpec(
                    "/cancel",
                    "取消当前任务",
                    "/cancel",
                    self._handle_cancel,
                    all_states,
                ),
                CommandSpec(
                    "/queue",
                    "查看或管理待处理消息",
                    "/queue [resume|clear]",
                    self._handle_queue,
                    all_states,
                    _queue_completions,
                ),
                CommandSpec(
                    "/clear",
                    "清空当前对话上下文",
                    "/clear",
                    self._handle_clear,
                    idle_only,
                ),
                CommandSpec(
                    "/help",
                    "查看命令帮助",
                    "/help",
                    self._handle_help,
                    all_states,
                ),
                CommandSpec("/exit", "退出程序", "/exit", allowed_states=all_states),
            )
        )

    def handle(self, command: str) -> bool:
        try:
            parts = shlex.split(command)
        except ValueError as error:
            self.output_fn(f"Invalid command: {error}")
            return True
        if not parts:
            return False

        spec = self.registry.get(parts[0])
        if spec is None or spec.handler is None:
            return False
        state = self._runtime_state()
        read_only_model_query = parts == ["/model", "current"]
        if (
            spec.allowed_states
            and state not in spec.allowed_states
            and not read_only_model_query
        ):
            self.output_fn(
                f"{spec.name} is unavailable while the task is {state.lower()}."
            )
            return True
        return spec.handler(parts[1:])

    def _runtime_state(self) -> str:
        if self.session is None:
            return "IDLE"
        active = getattr(self.session, "active_task", None)
        if active is None:
            return "IDLE"
        raw_state = getattr(active, "state", "IDLE")
        return str(getattr(raw_state, "name", raw_state)).upper()

    def _handle_help(self, arguments: list[str]) -> bool:
        if arguments:
            self.output_fn("Usage: /help")
            return True
        self.output_fn("Commands:")
        for spec in self.registry.all():
            self.output_fn(f"  {spec.usage:<32} {spec.description}")
        return True

    def _handle_cancel(self, arguments: list[str]) -> bool:
        if arguments:
            self.output_fn("Usage: /cancel")
            return True
        if self.session is None:
            self.output_fn("No active task to cancel.")
            return True
        cancelled = bool(self.session.cancel_active_task())
        self.output_fn(
            "Cancelling current task…" if cancelled else "No active task to cancel."
        )
        return True

    def _handle_queue(self, arguments: list[str]) -> bool:
        if len(arguments) > 1 or (arguments and arguments[0] not in {"resume", "clear"}):
            self.output_fn("Usage: /queue [resume|clear]")
            return True
        if self.session is None:
            self.output_fn("Pending: 0 · Held: 0 · Dead letters: 0")
            return True
        if arguments == ["clear"]:
            cleared = self.session.clear_queues()
            self.output_fn(f"Cleared {cleared} queued message(s).")
            return True
        if arguments == ["resume"]:
            resumed = self.session.resume_held()
            self.output_fn(f"Resumed {resumed} held message(s).")
            return True
        status = self.session.queue_status()
        self.output_fn(
            f"Pending: {status.get('pending', 0)}"
            f" ({status.get('pending_tokens', 0)} est. tokens)"
            f" · Held: {status.get('held', 0)}"
            f" ({status.get('held_tokens', 0)} est. tokens)"
            f" · Dead letters: {status.get('dead_letters', 0)}"
        )
        return True

    def _handle_clear(self, arguments: list[str]) -> bool:
        if arguments:
            self.output_fn("Usage: /clear")
            return True
        clear = getattr(self.agent, "clear_history", None)
        if callable(clear):
            clear()
        elif getattr(self.agent, "messages", None):
            self.agent.messages[:] = self.agent.messages[:1]
        self.output_fn("Conversation cleared.")
        return True

    def _handle_model(self, arguments: list[str]) -> bool:
        if arguments == ["current"]:
            self.output_fn(
                f"Current model: {self.current_config.provider} / "
                f"{self.current_config.model}"
            )
            return True
        if len(arguments) > 2:
            self.output_fn("Usage: /model [provider] [model]")
            return True

        provider = arguments[0] if arguments else None
        model = arguments[1] if len(arguments) == 2 else None
        try:
            selection = self.selector.select(
                provider_name=provider,
                model_name=model,
                prompt_for_missing_key=False,
            )
        except ValueError as error:
            self.output_fn(f"Could not switch model: {error}")
            return True
        if selection is None:
            return True
        previous_provider = self.current_config.provider
        previous_model = self.current_config.model
        self.agent.switch_model(
            client=selection.client,
            model=selection.config.model,
            provider=selection.config.provider,
        )
        self.current_config = selection.config
        self._publish_model_switched(previous_provider, previous_model)
        self.output_fn(
            f"Switched to {selection.config.provider} / {selection.config.model}"
        )
        return True

    def _handle_login(self, arguments: list[str]) -> bool:
        if len(arguments) > 1:
            self.output_fn("Usage: /login [provider]")
            return True
        provider = arguments[0] if arguments else self._choose_provider()
        if provider is None:
            return True
        try:
            get_provider(provider)
        except ValueError as error:
            self.output_fn(str(error))
            return True

        try:
            api_key = self.secret_input_fn(
                f"Enter {provider} API key: "
            ).strip()
        except (EOFError, KeyboardInterrupt):
            self.output_fn("Login cancelled; credentials were not changed.")
            return True
        if not api_key:
            self.output_fn("Login cancelled; credentials were not changed.")
            return True
        self.credentials.set(provider, api_key)
        if self.current_config.provider == provider:
            try:
                selection = self.selector.select(
                    provider_name=provider,
                    model_name=self.current_config.model,
                    prompt_for_missing_key=False,
                )
            except ValueError as error:
                self.output_fn(f"Credentials saved but could not be applied: {error}")
                return True
            if selection is not None:
                previous_provider = self.current_config.provider
                previous_model = self.current_config.model
                self.agent.switch_model(
                    client=selection.client,
                    model=selection.config.model,
                    provider=selection.config.provider,
                )
                self.current_config = selection.config
                self._publish_model_switched(previous_provider, previous_model)
                self.output_fn(f"Logged in to {provider}; credentials applied.")
                return True
        self.output_fn(f"Logged in to {provider}; use /model to select it.")
        return True

    def _handle_logout(self, arguments: list[str]) -> bool:
        if len(arguments) > 1:
            self.output_fn("Usage: /logout [provider]")
            return True
        provider = arguments[0] if arguments else self._choose_provider()
        if provider is None:
            return True
        try:
            get_provider(provider)
        except ValueError as error:
            self.output_fn(str(error))
            return True
        if self.credentials.remove(provider):
            suffix = (
                " The current client remains active until you switch models or exit."
                if self.current_config.provider == provider
                else ""
            )
            self.output_fn(f"Logged out of {provider}.{suffix}")
        else:
            self.output_fn(f"No credentials stored for {provider}.")
        return True

    def _handle_api_key(self, arguments: list[str]) -> bool:
        """Compatibility alias for the pre-/login credential commands."""
        if not arguments:
            configured = set(self.credentials.providers())
            for provider in provider_names():
                status = "configured" if provider in configured else "not configured"
                self.output_fn(f"{provider}: {status}")
            self.output_fn("Use /login or /logout to manage credentials.")
            return True
        if arguments[0] == "set":
            return self._handle_login(arguments[1:])
        if arguments[0] == "remove":
            return self._handle_logout(arguments[1:])
        self.output_fn("Usage: /apikey [set|remove] [provider]")
        return True

    def _publish_model_switched(
        self, previous_provider: str, previous_model: str
    ) -> None:
        event_bus = getattr(self.session, "event_bus", None)
        session_id = getattr(self.session, "session_id", None)
        if event_bus is None or session_id is None:
            return
        from .events import EventKind, EventSource

        event_bus.publish(
            EventKind.MODEL_SWITCHED,
            source=EventSource.SESSION,
            session_id=session_id,
            payload={
                "provider": self.current_config.provider,
                "model": self.current_config.model,
                "previous_provider": previous_provider,
                "previous_model": previous_model,
            },
        )

    def _choose_provider(self) -> str | None:
        providers = provider_names()
        for index, provider in enumerate(providers, start=1):
            self.output_fn(f"  {index}. {provider}")
        try:
            answer = self.selector.input_fn("Select provider: ").strip()
        except (EOFError, KeyboardInterrupt):
            self.output_fn("Provider selection cancelled.")
            return None
        try:
            return providers[int(answer) - 1]
        except (IndexError, ValueError):
            self.output_fn("Invalid provider selection.")
            return None
