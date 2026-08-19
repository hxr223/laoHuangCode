#!/usr/bin/env python3
"""Fail when the Python core and npm launcher versions diverge."""

from __future__ import annotations

import argparse
import ast
import json
from pathlib import Path
import re
import sys
import tomllib


ROOT = Path(__file__).resolve().parents[1]
STABLE_SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$"
)


def package_version() -> str:
    tree = ast.parse(
        (ROOT / "src" / "laohuangcode" / "__init__.py").read_text(
            encoding="utf-8"
        )
    )
    for statement in tree.body:
        if isinstance(statement, ast.Assign):
            if any(
                isinstance(target, ast.Name) and target.id == "__version__"
                for target in statement.targets
            ):
                value = ast.literal_eval(statement.value)
                if isinstance(value, str):
                    return value
    raise RuntimeError("__version__ was not found")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", help="release tag expected to equal v<version>")
    parser.add_argument(
        "--print-version",
        action="store_true",
        help="print only the synchronized version",
    )
    args = parser.parse_args(argv)
    pyproject = tomllib.loads(
        (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    )
    npm_package = json.loads(
        (ROOT / "npm" / "package.json").read_text(encoding="utf-8")
    )
    npm_lock = json.loads(
        (ROOT / "npm" / "package-lock.json").read_text(encoding="utf-8")
    )
    versions = {
        "python module": package_version(),
        "pyproject": pyproject["project"]["version"],
        "npm": npm_package["version"],
        "npm lockfile": npm_lock["version"],
        "npm lockfile root": npm_lock["packages"][""]["version"],
    }
    unique_versions = set(versions.values())
    if len(unique_versions) != 1:
        for source, version in versions.items():
            print(f"{source}: {version}", file=sys.stderr)
        return 1
    version = unique_versions.pop()
    if not STABLE_SEMVER.fullmatch(version):
        print(
            f"Release version must use stable SemVer X.Y.Z, got {version}",
            file=sys.stderr,
        )
        return 1
    if args.tag and args.tag != f"v{version}":
        print(
            f"Release tag {args.tag} does not match package version v{version}",
            file=sys.stderr,
        )
        return 1
    if args.print_version:
        print(version)
    else:
        print(f"Versions synchronized: {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
