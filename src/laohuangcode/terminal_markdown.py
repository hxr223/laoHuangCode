"""Convert Markdown into prompt_toolkit formatted text without terminal I/O."""

from __future__ import annotations

from io import StringIO
import re

from prompt_toolkit.formatted_text import ANSI, to_formatted_text
from prompt_toolkit.formatted_text.base import StyleAndTextTuples
from rich.console import Console
from rich.markdown import Markdown
from rich.theme import Theme

from .terminal_screen import strip_terminal_controls, truncate_to_width
from .terminal_theme import TerminalTheme


def render_markdown(
    text: str,
    width: int,
    theme: TerminalTheme,
) -> StyleAndTextTuples:
    """Render Markdown as prompt_toolkit fragments for the session renderer.

    Rich is used only as an in-memory Markdown parser/layout engine.  Its ANSI
    result is immediately converted to prompt_toolkit fragments, so this
    helper never writes to the user's terminal.  That preserves the
    single-renderer invariant while retaining Markdown formatting during
    streaming updates.
    """

    return _trim_line_padding(
        to_formatted_text(ANSI("\n".join(render_markdown_lines(text, width, theme))))
    )


_OSC8 = re.compile(r"\x1b]8;[^\x1b\x07]*(?:\x1b\\|\x07)")


def render_markdown_lines(
    text: str, width: int, theme: TerminalTheme
) -> tuple[str, ...]:
    """Return Rich-rendered ANSI logical lines without terminal I/O.

    The output deliberately retains SGR styling for the regular-terminal
    renderer, while removing OSC-8 control sequences that it cannot safely
    replay.  Each returned item is one logical line and has no newline.
    """

    output = StringIO()
    console = Console(
        file=output,
        force_terminal=True,
        color_system="truecolor",
        no_color=False,
        width=max(12, width),
        # Rich only honors an explicit width when both dimensions are set.
        # Markdown itself expands its render options to an unbounded height.
        height=1,
        theme=_markdown_theme(theme),
        highlight=False,
        legacy_windows=False,
    )
    console.print(
        Markdown(
            strip_terminal_controls(text),
            code_theme="ansi_light" if theme.name == "light" else "monokai",
            # prompt_toolkit's ANSI parser deliberately does not interpret
            # OSC-8 hyperlinks.  Render their visible URL instead of leaking
            # terminal control bytes into the transcript.
            hyperlinks=False,
        ),
        end="",
    )
    rendered = _OSC8.sub("", output.getvalue()).replace("\r\n", "\n")
    if rendered.endswith("\n"):
        rendered = rendered[:-1]
    lines = tuple(rendered.split("\n")) if rendered else ()
    return tuple(truncate_to_width(line, width) for line in lines)


def _markdown_theme(theme: TerminalTheme) -> Theme:
    colors = theme.color
    styles = {
        "markdown.paragraph": "",
        "markdown.h1": f"bold {colors('heading')}",
        "markdown.h2": f"bold {colors('heading')}",
        "markdown.h3": f"bold {colors('heading')}",
        "markdown.h4": f"bold {colors('heading')}",
        "markdown.h5": f"bold {colors('heading')}",
        "markdown.h6": f"bold {colors('heading')}",
        "markdown.strong": "bold",
        "markdown.em": "italic",
        "markdown.s": f"strike {colors('muted')}",
        "markdown.code": f"{colors('code')} on {colors('card')}",
        "markdown.block_quote": f"italic {colors('thinking')}",
        "markdown.item.bullet": colors("accent"),
        "markdown.item.number": colors("accent"),
        "markdown.link": f"underline {colors('link')}",
        "markdown.link_url": colors("muted"),
        "markdown.hr": colors("border_muted"),
        "markdown.table.header": f"bold {colors('heading')}",
        "markdown.table.border": colors("border_muted"),
    }
    return Theme(styles)


def _trim_line_padding(fragments: StyleAndTextTuples) -> StyleAndTextTuples:
    """Remove Rich's width-padding while retaining style boundaries."""

    result: StyleAndTextTuples = []
    line: StyleAndTextTuples = []

    def append(style: str, value: str) -> None:
        if not value:
            return
        if result and result[-1][0] == style:
            result[-1] = (style, result[-1][1] + value)
        else:
            result.append((style, value))

    def flush_line(*, newline: bool) -> None:
        while line:
            style, value = line[-1]
            trimmed = value.rstrip(" ")
            if trimmed == value:
                break
            if trimmed:
                line[-1] = (style, trimmed)
                break
            line.pop()
        for style, value in line:
            append(style, value)
        line.clear()
        if newline:
            append("", "\n")

    for style, value in fragments:
        for part in value.splitlines(keepends=True):
            if part.endswith("\n"):
                content = part[:-1].rstrip("\r")
                if content:
                    line.append((style, content))
                flush_line(newline=True)
            else:
                line.append((style, part))
    if line:
        flush_line(newline=False)
    return result
