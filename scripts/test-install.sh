#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
install_test_dir="$(mktemp -d)"
trap 'rm -rf -- "$install_test_dir"' EXIT

python3 -m venv "$install_test_dir/venv"
"$install_test_dir/venv/bin/python" -m pip install \
  --disable-pip-version-check "$project_root"
"$install_test_dir/venv/bin/laohuang" --version

LAOHUANG_PYTHON="$install_test_dir/venv/bin/python" \
  node "$project_root/npm/bin/laohuang.js" --version
