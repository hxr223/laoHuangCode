"""Command-line interface and subcommands for laoHuangCode."""

from __future__ import annotations

import argparse
from collections.abc import Callable, Mapping, Sequence
import json
import os
from pathlib import Path
import sys
from typing import Any

from . import __version__
from .agent import AgentError, CodingAgent
from .client import create_client
from .config import Config, ConfigManager
from .permissions import PermissionGate
from .providers import provider_names
from .tools import ToolRegistry
from .web import EventLog, WebDashboard


def run_repl(
    agent: Any,
    *,
    input_fn: Callable[[str], str] = input,
    output_fn: Callable[[str], None] = print,
) -> None:
    output_fn("laoHuangCode is ready. Type /exit to quit.")

    while True:
        try:
            user_input = input_fn("\nyou> ").strip()
        except EOFError:
            output_fn("\nGoodbye.")
            return
        except KeyboardInterrupt:
            output_fn("\nInterrupted. Type /exit to quit.")
            continue

        if user_input == "/exit":
            output_fn("Goodbye.")
            return
        if not user_input:
            continue

        try:
            response = agent.run(user_input)
        except AgentError as error:
            output_fn(f"\nError: {error}")
        except KeyboardInterrupt:
            output_fn("\nOperation interrupted.")
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
    input_fn: Callable[[str], str] = input,
    output_fn: Callable[[str], None] = print,
) -> int:
    args = _parser().parse_args(argv)
    environment = os.environ if environ is None else environ
    path = config_path or _default_config_path(environment)
    manager = ConfigManager(path)

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

        provider = args.provider or input_fn(
            f"Provider ({'/'.join(provider_names())}): "
        ).strip()
        try:
            manager.configure(
                name=args.config_profile,
                provider=provider,
                model=args.config_model,
                base_url=args.config_base_url,
            )
        except ValueError as error:
            print(f"Configuration error: {error}", file=sys.stderr)
            return 2
        output_fn(f"Saved profile '{args.config_profile}' to {path}")
        return 0

    try:
        if path.exists():
            config = manager.resolve(
                environ=environment,
                profile=args.profile,
                model=args.model,
                base_url=args.base_url,
            )
        else:
            config = Config.from_env(environment)
    except ValueError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 2

    if args.command == "doctor":
        output_fn(f"Provider: {config.provider}")
        output_fn(f"Model: {config.model}")
        output_fn(f"Base URL: {config.base_url or 'SDK default'}")
        output_fn("API key: configured")
        output_fn(f"Configuration: {path}")
        output_fn(
            f"Python: {sys.version_info.major}.{sys.version_info.minor}."
            f"{sys.version_info.micro}"
        )
        output_fn(f"Bash: {'available' if Path('/bin/bash').exists() else 'missing'}")
        return 0

    client = create_client(config)
    project_root = Path.cwd()
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
        output_fn(f"Web dashboard: {dashboard.url}")

    agent = CodingAgent(
        client=client,
        model=config.model,
        tools=ToolRegistry(project_root),
        on_tool_event=_tool_reporter(output_fn),
        on_agent_event=event_log.record if event_log is not None else None,
        permission_gate=PermissionGate(
            prompt=_permission_prompt(input_fn, output_fn),
            dangerously_skip_permissions=args.dangerously_skip_permissions,
        ),
    )
    try:
        run_repl(agent, input_fn=input_fn, output_fn=output_fn)
    finally:
        if dashboard is not None:
            dashboard.stop()
    return 0
