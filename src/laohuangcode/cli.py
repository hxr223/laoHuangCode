"""Command-line interface and subcommands for laoHuangCode."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Mapping, Sequence
import getpass
import os
from pathlib import Path
from queue import Queue
import sys
from threading import Event, Thread
from typing import Any

from . import __version__
from .agent import AgentError, CodingAgent
from .client import create_client
from .commands import SessionCommands
from .config import Config, ConfigManager
from .credentials import CredentialStore
from .events import EventProjector
from .model_selection import ModelSelector
from .providers import provider_names
from .semantic_classifier import SmallModelSemanticClassifier
from .session import AgentSession
from .terminal_ui import PlainEventSink, TerminalUI
from .tools import ToolRegistry
from .web import EventLog, WebDashboard


def run_repl(
    agent: Any,
    *,
    command_handler: Callable[[str], bool] | None = None,
    input_fn: Callable[[str], str] = input,
    output_fn: Callable[[str], None] = print,
    ui: Any | None = None,
) -> None:
    if ui is not None:
        ui.show_welcome()
    else:
        output_fn("laoHuangCode is ready. Type /help for commands or /exit to quit.")

    while True:
        try:
            user_input = (
                ui.prompt() if ui is not None else input_fn("\nyou> ")
            ).strip()
        except EOFError:
            if ui is not None:
                ui.show_goodbye()
            else:
                output_fn("\nGoodbye.")
            return
        except KeyboardInterrupt:
            if ui is not None:
                ui.show_interrupted()
            else:
                output_fn("\nInterrupted. Type /exit to quit.")
            continue

        if user_input == "/exit":
            if ui is not None:
                ui.show_goodbye()
            else:
                output_fn("Goodbye.")
            return
        if not user_input:
            continue
        if user_input.startswith("/"):
            if command_handler is not None and command_handler(user_input):
                continue
            message = f"Unknown command: {user_input.split()[0]}"
            if ui is not None:
                ui.write(message)
            else:
                output_fn(message)
            continue

        try:
            if ui is not None:
                with ui.thinking():
                    response = agent.run(user_input)
            else:
                response = agent.run(user_input)
        except AgentError as error:
            if ui is not None:
                ui.show_error(str(error))
            else:
                output_fn(f"\nError: {error}")
        except KeyboardInterrupt:
            if ui is not None:
                ui.show_interrupted(operation=True)
            else:
                output_fn("\nOperation interrupted.")
        else:
            if ui is not None:
                ui.show_assistant(response)
            else:
                output_fn(f"\nlaoHuangCode> {response}")


def run_session_repl(
    session: AgentSession,
    *,
    command_handler: Callable[[str], bool] | None = None,
    ui: TerminalUI,
) -> bool:
    """Keep accepting input while AgentSession executes in the background."""

    # The production TerminalUI owns a raw terminal loop. Feed it through a
    # coordinator queue so redraws never block on semantic routing or command
    # handlers.
    if callable(getattr(ui, "run", None)):
        return _run_persistent_session_repl(
            session, command_handler=command_handler, ui=ui
        )

    start_renderer = getattr(ui, "start_event_renderer", None)
    if callable(start_renderer):
        start_renderer()
    ui.show_welcome()
    clean_shutdown = False
    try:
        while True:
            try:
                user_input = ui.prompt().strip()
            except EOFError:
                break
            except KeyboardInterrupt:
                session.publish_notice("Interrupted.", style="yellow")
                continue

            if user_input == "/exit":
                session.submit_input(user_input)
                break
            if not user_input:
                continue
            if user_input.startswith("/"):
                if user_input == "/cancel":
                    submission = session.submit_input(user_input)
                    if submission.task_id is None:
                        session.publish_notice("No active task to cancel.")
                    continue
                session.submit_input(user_input)
                if command_handler is not None and command_handler(user_input):
                    continue
                command_name = user_input.split()[0]
                suggestion = None
                if ui.command_registry is not None:
                    suggestion = ui.command_registry.suggest(command_name)
                suffix = f" Did you mean {suggestion}?" if suggestion else ""
                session.publish_notice(
                    f"Unknown command: {command_name}.{suffix}"
                )
                continue

            try:
                submission = session.submit_input(user_input)
            except (OverflowError, RuntimeError, ValueError) as error:
                session.publish_notice(f"Error: {error}", style="bold red")
                continue
            if submission.queued:
                status = session.queue_status()
                session.publish_notice(
                    "Message queued "
                    f"(pending {status['pending']} · held {status['held']})."
                )
            elif submission.rejected:
                session.publish_notice(
                    f"Message rejected: {submission.reason}", style="bold red"
                )
    finally:
        clean_shutdown = session.close(wait=True, timeout=10)
        if clean_shutdown:
            session.event_bus.flush()
            flush_renderer = getattr(ui, "flush_event_renderer", None)
            if callable(flush_renderer):
                flush_renderer()
        ui.stop_event_renderer()
    if clean_shutdown:
        ui.show_goodbye()
    else:
        ui.show_error("Task worker did not stop before the shutdown timeout.")
    return clean_shutdown


def _run_persistent_session_repl(
    session: AgentSession,
    *,
    command_handler: Callable[[str], bool] | None,
    ui: TerminalUI,
) -> bool:
    """Drive a single-renderer terminal without writing outside its layout."""

    ui.show_welcome()
    submitted: Queue[str | None] = Queue()
    stopping = Event()
    drained = Event()
    drained.set()
    coordinator_errors: list[BaseException] = []

    def handle_input(user_input: str) -> bool:
        if user_input == "/exit":
            session.submit_input(user_input)
            return False
        if not user_input:
            return True
        if user_input.startswith("/"):
            if user_input == "/cancel":
                submission = session.submit_input(user_input)
                if submission.task_id is None:
                    session.publish_notice("No active task to cancel.")
                return True
            session.submit_input(user_input)
            if command_handler is not None and command_handler(user_input):
                return True
            command_name = user_input.split()[0]
            suggestion = (
                ui.command_registry.suggest(command_name)
                if ui.command_registry is not None
                else None
            )
            suffix = f" Did you mean {suggestion}?" if suggestion else ""
            session.publish_notice(f"Unknown command: {command_name}.{suffix}")
            return True
        try:
            submission = session.submit_input(user_input)
        except (OverflowError, RuntimeError, ValueError) as error:
            session.publish_notice(f"Error: {error}", style="bold red")
            return True
        if submission.queued:
            status = session.queue_status()
            session.publish_notice(
                "Message queued "
                f"(pending {status['pending']} · held {status['held']})."
            )
        elif submission.rejected:
            session.publish_notice(
                f"Message rejected: {submission.reason}", style="bold red"
            )
        return True

    def coordinate() -> None:
        while True:
            user_input = submitted.get()
            try:
                if user_input is None or stopping.is_set():
                    return
                handle_input(user_input)
            except BaseException as error:
                coordinator_errors.append(error)
            finally:
                submitted.task_done()
                if submitted.unfinished_tasks == 0:
                    drained.set()

    coordinator = Thread(
        target=coordinate, name="laohuang-input-coordinator", daemon=True
    )
    coordinator.start()
    clean_shutdown = False
    coordinator_alive = False
    try:
        def enqueue(user_input: str) -> None:
            # Exit is a local UI operation and should not wait behind a slow
            # semantic classification of an earlier queued message.
            if user_input == "/exit":
                try:
                    session.submit_input(user_input)
                except (OverflowError, RuntimeError, ValueError) as error:
                    session.publish_notice(f"Error: {error}", style="bold red")
                ui.request_exit()
                return
            drained.clear()
            submitted.put(user_input)

        ui.run(enqueue)
    finally:
        queue_drained = drained.wait(0.05)
        stopping.set()
        submitted.put(None)
        coordinator.join(timeout=2 if queue_drained else 0.05)
        coordinator_alive = coordinator.is_alive()
        if coordinator_alive or coordinator_errors:
            clean_shutdown = False
        else:
            clean_shutdown = session.close(wait=True, timeout=10)
        if clean_shutdown:
            session.event_bus.flush()
            flush_renderer = getattr(ui, "flush_event_renderer", None)
            if callable(flush_renderer):
                flush_renderer()
        close = getattr(ui, "close", None)
        if callable(close):
            close()
    render_error = getattr(ui, "render_error", None)
    clean = clean_shutdown and render_error is None
    if not clean and render_error is None and not coordinator_alive:
        ui.show_error("Task worker did not stop before the shutdown timeout.")
    return clean


def run_plain_session_repl(
    session: AgentSession,
    *,
    command_handler: Callable[[str], bool] | None = None,
    input_fn: Callable[[str], str] = input,
    sink: PlainEventSink,
) -> bool:
    """Run the same event-driven session with append-only plain output."""

    session.publish_notice(
        "laoHuangCode is ready. Type /help for commands or /exit to quit."
    )
    session.event_bus.flush()
    sink.flush()
    try:
        while True:
            try:
                user_input = input_fn("").strip()
            except EOFError:
                # A pipe may close immediately after submitting work. Let the
                # active task and its compatible pending batch finish normally.
                session.wait_for_idle()
                break
            except KeyboardInterrupt:
                session.publish_notice("Interrupted. Type /exit to quit.")
                continue

            if user_input == "/exit":
                session.submit_input(user_input)
                break
            if not user_input:
                continue
            if user_input.startswith("/"):
                if user_input == "/cancel":
                    submission = session.submit_input(user_input)
                    if submission.task_id is None:
                        session.publish_notice("No active task to cancel.")
                    continue
                session.submit_input(user_input)
                if command_handler is not None and command_handler(user_input):
                    continue
                session.publish_notice(
                    f"Unknown command: {user_input.split()[0]}"
                )
                continue
            try:
                submission = session.submit_input(user_input)
            except (OverflowError, RuntimeError, ValueError) as error:
                session.publish_notice(f"Error: {error}")
                continue
            if submission.queued:
                status = session.queue_status()
                session.publish_notice(
                    "Message queued "
                    f"(pending {status['pending']} · held {status['held']})."
                )
            elif submission.rejected:
                session.publish_notice(f"Message rejected: {submission.reason}")
    finally:
        clean_shutdown = session.close(wait=True, timeout=10)
        if clean_shutdown:
            session.event_bus.flush()
            sink.flush()
        sink.stop(drain=clean_shutdown)
    output = sink.output_fn
    if clean_shutdown:
        output("Goodbye.")
    else:
        output("Error: Task worker did not stop before the shutdown timeout.")
    return clean_shutdown


def _supports_terminal_ui(
    *,
    input_fn: Callable[[str], str],
    output_fn: Callable[[str], None],
    stdin: Any = None,
    stdout: Any = None,
) -> bool:
    """Only enable the interactive UI for the process's real TTY streams."""
    input_stream = sys.stdin if stdin is None else stdin
    output_stream = sys.stdout if stdout is None else stdout
    return (
        input_fn is input
        and output_fn is print
        and bool(getattr(input_stream, "isatty", lambda: False)())
        and bool(getattr(output_stream, "isatty", lambda: False)())
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="A minimal coding agent")
    parser.add_argument(
        "--version", action="version", version=f"laohuang {__version__}"
    )
    parser.add_argument("--profile", help="model profile for this session")
    parser.add_argument("--model", help="model override for this session")
    parser.add_argument("--base-url", help="API base URL override for this session")
    parser.add_argument(
        "--theme",
        choices=("auto", "dark", "light"),
        default="auto",
        help="interactive terminal theme (default: auto)",
    )
    parser.add_argument(
        "--web",
        action="store_true",
        help="start the local agent trace dashboard",
    )
    parser.add_argument(
        "--web-port",
        type=int,
        default=8765,
        metavar="PORT",
        help="dashboard port (default: 8765; use 0 for any free port)",
    )
    subcommands = parser.add_subparsers(dest="command")
    configure = subcommands.add_parser("config", help="configure a model profile")
    configure.add_argument(
        "config_action",
        nargs="?",
        choices=("set", "list", "use"),
        default="set",
    )
    configure.add_argument("config_target", nargs="?")
    configure.add_argument("--profile", default="default", dest="config_profile")
    configure.add_argument("--provider", choices=provider_names())
    configure.add_argument("--model", dest="config_model")
    configure.add_argument("--base-url", dest="config_base_url")
    subcommands.add_parser("doctor", help="check local configuration")
    return parser


def _default_config_path(environment: Mapping[str, str]) -> Path:
    explicit = environment.get("LAOHUANG_CONFIG")
    if explicit:
        return Path(explicit).expanduser()
    config_home = environment.get("XDG_CONFIG_HOME")
    root = Path(config_home).expanduser() if config_home else Path.home() / ".config"
    return root / "laohuang" / "config.json"


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    config_path: Path | None = None,
    credentials_path: Path | None = None,
    input_fn: Callable[[str], str] = input,
    secret_input_fn: Callable[[str], str] = getpass.getpass,
    output_fn: Callable[[str], None] = print,
    client_factory: Callable[..., Any] | None = None,
) -> int:
    args = _parser().parse_args(argv)
    environment = os.environ if environ is None else environ
    project_root = Path.cwd()
    terminal_ui: TerminalUI | None = None
    if _supports_terminal_ui(input_fn=input_fn, output_fn=output_fn):
        terminal_ui = TerminalUI(project_root=project_root, theme=args.theme)
        input_fn = terminal_ui.prompt
        output_fn = terminal_ui.write

    path = config_path or _default_config_path(environment)
    manager = ConfigManager(path)
    credentials = CredentialStore(
        credentials_path or path.with_name("credentials.json")
    )
    selector = ModelSelector(
        credentials=credentials,
        input_fn=input_fn,
        secret_input_fn=secret_input_fn,
        output_fn=output_fn,
        client_factory=client_factory,
    )

    if args.command == "config":
        if args.config_action == "list":
            try:
                profiles = manager.list_profiles()
            except ValueError as error:
                print(f"Configuration error: {error}", file=sys.stderr)
                return 2
            for profile in profiles:
                marker = "*" if profile["active"] else " "
                output_fn(
                    f"{marker} {profile['name']}  "
                    f"{profile['provider']}  {profile['model']}"
                )
            return 0

        if args.config_action == "use":
            if not args.config_target:
                print("Configuration error: profile name is required", file=sys.stderr)
                return 2
            try:
                manager.set_active(args.config_target)
            except ValueError as error:
                print(f"Configuration error: {error}", file=sys.stderr)
                return 2
            output_fn(f"Active profile: {args.config_target}")
            return 0

        try:
            selection = selector.select(
                provider_name=args.provider,
                model_name=args.config_model,
            )
            if selection is None:
                return 2
            manager.configure(
                name=args.config_profile,
                provider=selection.config.provider,
                model=selection.config.model,
                base_url=(
                    args.config_base_url
                    if args.config_base_url is not None
                    else selection.config.base_url
                ),
            )
        except ValueError as error:
            print(f"Configuration error: {error}", file=sys.stderr)
            return 2
        output_fn(f"Saved profile '{args.config_profile}' to {path}")
        return 0

    if args.command == "doctor":
        try:
            settings = manager.resolve_settings(
                environ=environment,
                profile=args.profile,
                model=args.model,
                base_url=args.base_url,
            )
        except ValueError as error:
            print(f"Configuration error: {error}", file=sys.stderr)
            return 2
        key_configured = credentials.get(settings.provider) is not None
        output_fn(f"Provider: {settings.provider}")
        output_fn(f"Model: {settings.model}")
        output_fn(f"Base URL: {settings.base_url or 'SDK default'}")
        output_fn(
            f"API key: {'configured' if key_configured else 'not configured'}"
        )
        output_fn(f"Configuration: {path}")
        output_fn(
            f"Python: {sys.version_info.major}.{sys.version_info.minor}."
            f"{sys.version_info.micro}"
        )
        output_fn(f"Bash: {'available' if Path('/bin/bash').exists() else 'missing'}")
        return 0 if key_configured else 1

    runtime_client: Any | None = None
    try:
        if path.exists():
            config = manager.resolve(
                credentials=credentials,
                environ=environment,
                profile=args.profile,
                model=args.model,
                base_url=args.base_url,
            )
        else:
            selection = selector.select()
            if selection is None:
                return 2
            config = selection.config
            runtime_client = selection.client
            manager.configure(
                name="default",
                provider=config.provider,
                model=config.model,
                base_url=config.base_url,
            )
            output_fn(
                f"Configured {config.provider} / {config.model} as default."
            )
    except ValueError as error:
        if (
            path.exists()
            and args.command is None
            and str(error).startswith("No API key configured")
        ):
            try:
                settings = manager.resolve_settings(
                    environ=environment,
                    profile=args.profile,
                    model=args.model,
                    base_url=args.base_url,
                )
                selection = selector.select(
                    provider_name=settings.provider,
                    model_name=settings.model,
                )
            except ValueError as selection_error:
                print(
                    f"Configuration error: {selection_error}",
                    file=sys.stderr,
                )
                return 2
            if selection is None:
                return 2
            config = selection.config
            runtime_client = selection.client
        else:
            print(f"Configuration error: {error}", file=sys.stderr)
            return 2

    if terminal_ui is not None:
        terminal_ui.provider = config.provider
        terminal_ui.model = config.model
        terminal_ui.state.provider = config.provider
        terminal_ui.state.model = config.model

    client = runtime_client or create_client(
        config,
        client_factory=client_factory,
    )
    event_log: EventLog | None = None
    dashboard: WebDashboard | None = None
    if args.web:
        event_log = EventLog()
        event_log.record(
            "session_start",
            {
                "project_root": str(project_root),
                "provider": config.provider,
                "model": config.model,
                "profile": config.profile,
            },
        )
        try:
            dashboard = WebDashboard(event_log, port=args.web_port)
            dashboard.start()
        except OSError as error:
            print(f"Web dashboard error: {error}", file=sys.stderr)
            return 2
        if terminal_ui is not None:
            terminal_ui.dashboard_url = dashboard.url
        else:
            output_fn(f"Web dashboard: {dashboard.url}")

    agent = CodingAgent(
        client=client,
        model=config.model,
        tools=ToolRegistry(project_root),
        on_tool_event=None,
        on_agent_event=None,
        provider=config.provider,
    )
    semantic_classifier = SmallModelSemanticClassifier(
        client=client,
        model=config.model,
    )
    runtime = AgentSession(agent, semantic_classifier=semantic_classifier)
    plain_sink = PlainEventSink(output_fn) if terminal_ui is None else None
    session_sink = terminal_ui if terminal_ui is not None else plain_sink
    assert session_sink is not None

    repl_input_fn = input_fn
    session_secret_input_fn = secret_input_fn
    if plain_sink is not None:
        underlying_input = input_fn
        underlying_secret_input = secret_input_fn

        def plain_input(prompt: str) -> str:
            if prompt:
                runtime.publish_notice(prompt)
                runtime.event_bus.flush()
                plain_sink.flush()
            return underlying_input("")

        def plain_secret_input(prompt: str) -> str:
            if prompt:
                runtime.publish_notice(prompt)
                runtime.event_bus.flush()
                plain_sink.flush()
            return underlying_secret_input("")

        repl_input_fn = plain_input
        session_secret_input_fn = plain_secret_input
        selector.input_fn = plain_input
    elif terminal_ui is not None:
        session_secret_input_fn = terminal_ui.prompt_secret

    def session_output(message: str) -> None:
        runtime.publish_notice(message)

    selector.output_fn = session_output
    commands = SessionCommands(
        agent=agent,
        selector=selector,
        credentials=credentials,
        current_config=config,
        secret_input_fn=session_secret_input_fn,
        output_fn=session_output,
        session=runtime,
    )
    unsubscribers: list[Callable[[], None]] = []
    projector = EventProjector()
    unsubscribers.append(
        runtime.event_bus.subscribe(
            lambda event: session_sink.publish_event(
                projector.project(event, "terminal")
            )
        )
    )
    if event_log is not None:
        unsubscribers.append(
            runtime.event_bus.subscribe(
                lambda event: event_log.record_event(
                    projector.project(event, "web")
                )
            )
        )
    if terminal_ui is not None:
        terminal_ui.set_command_registry(commands.registry)
        terminal_ui.set_cancel_callback(lambda: commands.handle("/cancel"))
        terminal_ui.set_runtime_running_callback(
            lambda: runtime.active_task is not None
        )

    def handle_command(command: str) -> bool:
        handled = commands.handle(command)
        semantic_classifier.configure(client=agent.client, model=agent.model)
        return handled

    clean_shutdown = False
    try:
        if terminal_ui is not None:
            clean_shutdown = run_session_repl(
                runtime,
                command_handler=handle_command,
                ui=terminal_ui,
            )
        else:
            assert plain_sink is not None
            clean_shutdown = run_plain_session_repl(
                runtime,
                command_handler=handle_command,
                input_fn=repl_input_fn,
                sink=plain_sink,
            )
    finally:
        for unsubscribe in unsubscribers:
            unsubscribe()
        if dashboard is not None:
            dashboard.stop()
    return 0 if clean_shutdown else 1
