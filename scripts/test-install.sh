#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
install_test_dir="$(mktemp -d)"
trap 'rm -rf -- "$install_test_dir"' EXIT
test_python="${LAOHUANG_BUILD_PYTHON:-python3}"
package_version="$(PYTHONPATH="$project_root/src" "$test_python" -c \
  'from laohuangcode import __version__; print(__version__)')"
wheel_path="$project_root/dist/laohuangcode-$package_version-py3-none-any.whl"
if [[ ! -f "$wheel_path" ]]; then
  echo "Expected wheel is missing: $wheel_path" >&2
  exit 1
fi

"$test_python" -m venv "$install_test_dir/venv"
"$install_test_dir/venv/bin/python" -m pip install \
  --disable-pip-version-check "$wheel_path"
"$install_test_dir/venv/bin/laohuang" --version

npm_tarball="$install_test_dir/laohuang.tgz"
npm pack "$project_root/npm" --pack-destination "$install_test_dir" >/dev/null
mv "$install_test_dir"/laohuang-*.tgz "$npm_tarball"
npm install --prefix "$install_test_dir/npm-install" "$npm_tarball" >/dev/null
LAOHUANG_CACHE_HOME="$install_test_dir/cache" \
  "$install_test_dir/npm-install/node_modules/.bin/laohuang" --version
