#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
check_python="${LAOHUANG_BUILD_PYTHON:-python3}"

cd "$project_root"
"$check_python" scripts/check_versions.py
PYTHONPATH=src "$check_python" -m unittest discover -s tests -v
LAOHUANG_BUILD_PYTHON="$check_python" scripts/build-python.sh
npm --prefix npm test
npm pack ./npm --dry-run
LAOHUANG_BUILD_PYTHON="$check_python" scripts/test-install.sh
