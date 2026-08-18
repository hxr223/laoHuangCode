"""Terminal entry point for laoHuangCode."""

from __future__ import annotations

from collections.abc import Callable
import json
from pathlib import Path
import sys
from typing import Any

from .agent import AgentError, CodingAgent
from .config import Config
from .tools import ToolRegistry


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


def _print_tool_event(
    name: str, arguments: dict[str, Any], result: dict[str, Any]
) -> None:
    safe_arguments = dict(arguments)
    for key in ("content", "old_text", "new_text"):
        value = safe_arguments.get(key)
        if isinstance(value, str):
            safe_arguments[key] = f"<{len(value)} chars>"
    print(f"\n[tool] {name} {_summarize(safe_arguments)}")
    print(f"[result] {_summarize(result, limit=2_000)}")


def main() -> int:
    try:
        config = Config.from_env()
    except ValueError as error:
        print(f"Configuration error: {error}", file=sys.stderr)
        return 2

    from openai import OpenAI

    client_options: dict[str, Any] = {"api_key": config.api_key}
    if config.base_url:
        client_options["base_url"] = config.base_url

    client = OpenAI(**client_options)
    agent = CodingAgent(
        client=client,
        model=config.model,
        tools=ToolRegistry(Path.cwd()),
        on_tool_event=_print_tool_event,
    )
    run_repl(agent)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
