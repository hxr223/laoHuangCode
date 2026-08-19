"""Command-line interface and subcommands for laoHuangCode."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Mapping, Sequence
import getpass
import json
import os
from pathlib import Path
import sys
from typing import Any

from . import __version__
from .agent import AgentError, CodingAgent
from .client import create_client
from .commands import SessionCommands
from .config import Config, ConfigManager
from .credentials import CredentialStore
from .model_selection import ModelSelector
from .permissions import PermissionGate
from .providers import provider_names
from .terminal_ui import TerminalUI
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


def _summarize(value: Any, limit: int = 500) -> str:
    text = json.dumps(value, ensure_ascii=False)
    if len(text) <= limit:
        return text
    return text[:limit] + "...[truncated]"


def _tool_reporter(
    output_fn: Callable[[str], None]
) -> Callable[[str, dict[str, Any], dict[str, Any]], None]:
    def report(
        name: str, arguments: dict[str, Any], result: dict[str, Any]
    ) -> None:
        safe_arguments = dict(arguments)
        for key in ("content", "old_text", "new_text"):
            value = safe_arguments.get(key)
            if isinstance(value, str):
                safe_arguments[key] = f"<{len(value)} chars>"
        output_fn(f"\n[tool] {name} {_summarize(safe_arguments)}")
        output_fn(f"[result] {_summarize(result, limit=2_000)}")

    return report


def _permission_prompt(
    input_fn: Callable[[str], str],
    output_fn: Callable[[str], None],
) -> Callable[[str, dict[str, Any]], str]:
    def prompt(name: str, arguments: dict[str, Any]) -> str:
        safe_arguments = dict(arguments)
        for key in ("content", "old_text", "new_text"):
            value = safe_arguments.get(key)
            if isinstance(value, str):
                safe_arguments[key] = f"<{len(value)} chars>"
        output_fn(f"\nPermission required: {name} {_summarize(safe_arguments)}")
        return input_fn("Allow? [y/N/a] ")

    return prompt


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
    parser.add_argument(
        "--dangerously-skip-permissions",
        action="store_true",
        help="allow write, edit, and bash without confirmation",
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
        terminal_ui = TerminalUI(project_root=project_root)
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
                "permission_mode": (
                    "bypass"
                    if args.dangerously_skip_permissions
                    else "confirm"
                ),
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
        on_tool_event=(
            terminal_ui.show_tool
            if terminal_ui is not None
            else _tool_reporter(output_fn)
        ),
        on_agent_event=event_log.record if event_log is not None else None,
        permission_gate=PermissionGate(
            prompt=(
                terminal_ui.ask_permission
                if terminal_ui is not None
                else _permission_prompt(input_fn, output_fn)
            ),
            dangerously_skip_permissions=args.dangerously_skip_permissions,
        ),
        provider=config.provider,
    )
    commands = SessionCommands(
        agent=agent,
        selector=selector,
        credentials=credentials,
        current_config=config,
        secret_input_fn=secret_input_fn,
        output_fn=output_fn,
    )
    try:
        run_repl(
            agent,
            command_handler=commands.handle,
            input_fn=input_fn,
            output_fn=output_fn,
            ui=terminal_ui,
        )
    finally:
        if dashboard is not None:
            dashboard.stop()
    return 0
