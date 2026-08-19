#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
build_python="${LAOHUANG_BUILD_PYTHON:-python3}"

cd "$project_root"
"$build_python" scripts/check_versions.py
"$build_python" -m build
