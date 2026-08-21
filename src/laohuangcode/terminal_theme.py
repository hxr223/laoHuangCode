"""Pi-inspired color tokens shared by the interactive terminal renderers."""

from __future__ import annotations

from dataclasses import dataclass
from os import environ
from typing import Mapping

from prompt_toolkit.styles import Style


@dataclass(frozen=True, slots=True)
class TerminalTheme:
    """Semantic colors for terminal UI, independent from a rendering library."""

    name: str
    colors: Mapping[str, str]

    def color(self, token: str) -> str:
        return self.colors[token]

    def rich_style(self, token: str, *, background: bool = False) -> str:
        color = self.color(token)
        return f"on {color}" if background else color

    def prompt_style(self) -> Style:
        return Style.from_dict(
            {
                "frame.border": self.color("border_muted"),
                "input-padding": "",
                "prompt": f"bold {self.color('accent')}",
                "footer": self.color("dim"),
                "completion-menu.completion": (
                    f"bg:{self.color('card')} {self.color('text')}"
                ),
                "completion-menu.completion.current": (
                    f"bg:{self.color('selected_bg')} {self.color('text')}"
                ),
                "completion-menu.meta.completion": (
                    f"bg:{self.color('card')} {self.color('muted')}"
                ),
                "completion-menu.meta.completion.current": (
                    f"bg:{self.color('selected_bg')} {self.color('text')}"
                ),
            }
        )


PI_DARK = TerminalTheme(
    name="dark",
    colors={
        "accent": "#8abeb7",
        "border": "#5f87ff",
        "border_muted": "#505050",
        "text": "#d4d4d4",
        "muted": "#808080",
        "dim": "#666666",
        "success": "#b5bd68",
        "error": "#cc6666",
        "warning": "#ffff00",
        "user_bg": "#343541",
        "tool_pending_bg": "#282832",
        "tool_success_bg": "#283228",
        "tool_error_bg": "#3c2828",
        "card": "#1e1e24",
        "selected_bg": "#3a3a4a",
        "code": "#b5bd68",
        "heading": "#f0c674",
        "link": "#81a2be",
        "thinking": "#808080",
        "bash": "#b5bd68",
    },
)

PI_LIGHT = TerminalTheme(
    name="light",
    colors={
        "accent": "#5a8080",
        "border": "#547da7",
        "border_muted": "#b0b0b0",
        "text": "#1f2328",
        "muted": "#6c6c6c",
        "dim": "#767676",
        "success": "#588458",
        "error": "#aa5555",
        "warning": "#9a7326",
        "user_bg": "#e8e8e8",
        "tool_pending_bg": "#e8e8f0",
        "tool_success_bg": "#e8f0e8",
        "tool_error_bg": "#f0e8e8",
        "card": "#ffffff",
        "selected_bg": "#d0d0e0",
        "code": "#588458",
        "heading": "#9a7326",
        "link": "#547da7",
        "thinking": "#6c6c6c",
        "bash": "#588458",
    },
)


def resolve_terminal_theme(name: str | None = None) -> TerminalTheme:
    """Resolve an explicit Pi-style theme, defaulting from terminal settings."""
    requested = (name or "auto").strip().lower()
    if requested == "light":
        return PI_LIGHT
    if requested == "dark":
        return PI_DARK
    if requested != "auto":
        raise ValueError("terminal theme must be 'auto', 'dark', or 'light'")

    colorfgbg = environ.get("COLORFGBG", "")
    background = colorfgbg.split(";")[-1] if colorfgbg else ""
    try:
        return PI_LIGHT if int(background) >= 7 else PI_DARK
    except ValueError:
        return PI_DARK
