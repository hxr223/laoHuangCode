#!/usr/bin/env python3
"""Fail unless the repository version is still available on npm."""

from __future__ import annotations

import json
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
REGISTRY_URL = "https://registry.npmjs.org"


def package_identity() -> tuple[str, str]:
    package = json.loads(
        (ROOT / "npm" / "package.json").read_text(encoding="utf-8")
    )
    return package["name"], package["version"]


def is_published(
    package_name: str,
    version: str,
    *,
    registry_url: str = REGISTRY_URL,
) -> bool:
    url = (
        f"{registry_url.rstrip('/')}"
        f"/{quote(package_name, safe='')}"
        f"/{quote(version, safe='')}"
    )
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "laoHuangCode-release-check",
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            if response.status == 200:
                return True
            raise RuntimeError(
                f"npm registry returned unexpected HTTP {response.status}"
            )
    except HTTPError as error:
        if error.code == 404:
            return False
        raise RuntimeError(
            f"npm registry returned HTTP {error.code}"
        ) from error
    except URLError as error:
        raise RuntimeError(f"Could not reach the npm registry: {error.reason}") from error


def latest_published_version(
    package_name: str,
    *,
    registry_url: str = REGISTRY_URL,
) -> str | None:
    url = f"{registry_url.rstrip('/')}/{quote(package_name, safe='')}/latest"
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "laoHuangCode-release-check",
        },
    )
    try:
        with urlopen(request, timeout=15) as response:
            if response.status != 200:
                raise RuntimeError(
                    f"npm registry returned unexpected HTTP {response.status}"
                )
            metadata = json.loads(response.read())
    except HTTPError as error:
        if error.code == 404:
            return None
        raise RuntimeError(
            f"npm registry returned HTTP {error.code}"
        ) from error
    except URLError as error:
        raise RuntimeError(f"Could not reach the npm registry: {error.reason}") from error
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise RuntimeError("npm registry returned invalid package metadata") from error
    version = metadata.get("version")
    if not isinstance(version, str):
        raise RuntimeError("npm registry metadata did not contain a version")
    return version


def stable_version_tuple(version: str) -> tuple[int, int, int]:
    try:
        parts = tuple(int(part) for part in version.split("."))
    except ValueError as error:
        raise RuntimeError(f"npm latest tag has unsupported version {version}") from error
    if len(parts) != 3:
        raise RuntimeError(f"npm latest tag has unsupported version {version}")
    return parts


def main() -> int:
    package_name, version = package_identity()
    try:
        published = is_published(package_name, version)
        latest_version = latest_published_version(package_name)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 2
    if published:
        print(
            f"{package_name}@{version} is already published; "
            "bump the version before merging",
            file=sys.stderr,
        )
        return 1
    try:
        is_newer = not latest_version or stable_version_tuple(
            version
        ) > stable_version_tuple(latest_version)
    except RuntimeError as error:
        print(error, file=sys.stderr)
        return 2
    if not is_newer:
        print(
            f"{package_name}@{version} must be newer than npm latest "
            f"{latest_version}",
            file=sys.stderr,
        )
        return 1
    print(f"npm version is available: {package_name}@{version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
