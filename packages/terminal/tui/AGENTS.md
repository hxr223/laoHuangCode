# TUI Rules

## Product Contract

`packages/terminal/tui/` owns terminal presentation: component rendering,
layout, focus, overlays, keyboard input, transcript display, and terminal
screen painting. Agent runtime, model calls, tool execution, and session
orchestration stay outside this package.

## Component Direction

- Add new visible TUI behavior as a component or view-like unit before wiring it into
  `TerminalUI`.
- Keep `TerminalUI` focused on assembly, event routing, render scheduling, and loop
  coordination.
- Do not add new transcript, tool-card, completion, status, or overlay rendering as
  ad-hoc private methods on `TerminalUI` when a component can own it.
- Components receive state and callbacks through typed inputs. They must not call
  model clients, tools, agent runtime, or session lifecycle objects directly.
- Runtime events should be projected into TUI state before components render them.

## Boundaries

- Runtime packages publish runtime events and lifecycle state; they must not import from `@laohuang/tui`.
- `@laohuang/tui` may import stable event/state types from non-UI layers, but presentation
  policy and render state live here.
- Keep terminal byte handling, screen diffing, layout, focus, and overlays inside
  this package.

## Tests

- Visible UI changes need focused tests for the changed component or render path.
- Interactive terminal behavior should keep using controlled test drivers or tmux
  smoke scripts; do not require real provider credentials.
