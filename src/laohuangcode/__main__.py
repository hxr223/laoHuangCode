"""Module entry point for ``python -m laohuangcode``."""

from .cli import main, run_repl

__all__ = ["main", "run_repl"]


if __name__ == "__main__":
    raise SystemExit(main())
