#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
build_python="${LAOHUANG_BUILD_PYTHON:-python3}"

cd "$project_root"
"$build_python" scripts/check_versions.py
mkdir -p "$project_root/dist"
find "$project_root/dist" -maxdepth 1 -type f \
  \( -name 'laohuangcode-*.whl' -o -name 'laohuangcode-*.tar.gz' \) -delete
"$build_python" -m build

package_version="$(PYTHONPATH="$project_root/src" "$build_python" -c \
  'from laohuangcode import __version__; print(__version__)')"
wheel_path="$project_root/dist/laohuangcode-$package_version-py3-none-any.whl"
if [[ ! -f "$wheel_path" ]]; then
  echo "Expected wheel was not built: $wheel_path" >&2
  exit 1
fi

mkdir -p "$project_root/npm/vendor"
find "$project_root/npm/vendor" -maxdepth 1 -type f \
  -name 'laohuangcode-*-py3-none-any.whl' -delete
cp "$wheel_path" "$project_root/npm/vendor/"
