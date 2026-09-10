#!/bin/sh
# Install the self-contained release. No system Node.js or npm is required.
set -eu

fail() { printf 'laohuang installer: %s\n' "$*" >&2; exit 1; }
version=${LAOHUANG_VERSION:-}
install_dir=${LAOHUANG_INSTALL_DIR:-"$HOME/.local/share/laohuang"}
base=${LAOHUANG_DOWNLOAD_BASE:-https://github.com/hxr223/laoHuangCode/releases}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || fail '--version requires a value'; version=$2; shift 2 ;;
    --no-modify-path) LAOHUANG_NO_MODIFY_PATH=1; shift ;;
    --help) printf '%s\n' 'Usage: install.sh [--version X.Y.Z] [--no-modify-path]' 'Environment: LAOHUANG_INSTALL_DIR, LAOHUANG_VERSION, LAOHUANG_NO_MODIFY_PATH'; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
case "$install_dir" in /*) ;; *) fail 'Installation directory must be absolute' ;; esac
case "$install_dir" in *:*) fail 'Installation directory cannot contain a colon' ;; esac
[ "$(printf '%s' "$install_dir" | tr -d '\r\n')" = "$install_dir" ] || fail 'Installation directory cannot contain newlines'
case "$base" in https://*|file://*) ;; *) fail 'Download source must use HTTPS' ;; esac
for tool in curl tar mktemp; do command -v "$tool" >/dev/null 2>&1 || fail "Required command missing: $tool"; done
command -v bash >/dev/null 2>&1 || fail 'Bash is required. Install Bash with your system package manager, then rerun this installer.'
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail 'Unsupported OS; Windows users should run install.ps1' ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) fail 'Supported architectures: x64 and arm64' ;; esac
if [ "$os" = linux ] && ldd /bin/sh 2>&1 | grep -qi musl; then
  fail 'Standalone packages require glibc. On musl Linux, use Node.js and npm install -g laohuang.'
fi
download() { curl --fail --silent --show-error --location --retry 2 --connect-timeout 15 --max-time 600 "$1" -o "$2"; }
stable_version() { printf '%s\n' "$1" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' && [ "$(printf '%s' "$1" | tr -d '\r\n')" = "$1" ]; }
mkdir -p "$install_dir/releases" "$install_dir/bin"
lock="$install_dir/.install-lock"
mkdir "$lock" 2>/dev/null || fail "Installation lock exists: $lock. Remove it only after confirming no installer is running."
stage=
cleanup() { [ -z "$stage" ] || rm -r "$stage"; rmdir "$lock"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
stage=$(mktemp -d "$install_dir/releases/.install.XXXXXX")
if [ -z "$version" ]; then
  download "$base/latest/download/version.txt" "$stage/version.txt"
  version=$(cat "$stage/version.txt")
fi
stable_version "$version" || fail 'Invalid release version; expected X.Y.Z'
url="$base/download/v$version"
archive="laohuang-$version-$os-$arch.tar.gz"
printf 'Downloading laohuang %s (%s-%s)...\n' "$version" "$os" "$arch"
download "$url/$archive.sha256" "$stage/checksum"
download "$url/$archive" "$stage/archive.tar.gz"
expected=$(awk 'NR == 1 {print $1}' "$stage/checksum")
printf '%s\n' "$expected" | grep -Eq '^[a-fA-F0-9]{64}$' || fail 'Invalid SHA-256 checksum'
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$stage/archive.tar.gz" | awk '{print $1}');
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$stage/archive.tar.gz" | awk '{print $1}');
else fail 'shasum or sha256sum is required to verify the download'; fi
[ "$expected" = "$actual" ] || fail 'Download checksum mismatch; existing installation was not changed'
mkdir "$stage/package"
tar -xzf "$stage/archive.tar.gz" -C "$stage/package"
package="$stage/package"
[ -x "$package/laohuang" ] || fail 'Release is missing its launcher'
actual_version=$("$package/laohuang" --version)
[ "$actual_version" = "$version" ] || [ "$actual_version" = "laohuang $version" ] || fail "Release version mismatch: $actual_version"

# Update the profile before switching the command. Keep user content intact.
bin="$install_dir/bin"
quote() { printf "'"; printf '%s' "$1" | sed "s/'/'\\\\''/g"; printf "'"; }
shell_name=$(basename "${SHELL:-sh}")
login_profile=
case "$shell_name" in
  zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
  bash)
    profile="$HOME/.bashrc"
    # Bash reads only the first existing login profile. Do not mask the user's
    # .bash_login or .profile by creating a new higher-priority file.
    for candidate in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
      if [ -f "$candidate" ]; then login_profile=$candidate; break; fi
    done
    if [ -z "$login_profile" ]; then
      if [ "$os" = darwin ]; then login_profile="$HOME/.bash_profile"; else login_profile="$HOME/.profile"; fi
    fi ;;
  fish) profile="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/laohuang.fish" ;;
  *) profile="$HOME/.profile" ;;
esac
if [ "$shell_name" = fish ]; then
  fish_bin=$(printf '%s' "$bin" | sed "s/\\\\/\\\\\\\\/g; s/'/\\\\'/g")
  path_line="fish_add_path -- '$fish_bin'"
else path_line="export PATH=$(quote "$bin"):\"\$PATH\""; fi
if [ -z "${LAOHUANG_NO_MODIFY_PATH:-}" ]; then
  for config_file in "$profile" "$login_profile"; do
    [ -n "$config_file" ] || continue
    mkdir -p "$(dirname "$config_file")"
    if ! grep -Fqx "$path_line" "$config_file" 2>/dev/null; then
      printf '\n# laohuang installer\n%s\n' "$path_line" >> "$config_file"
    fi
    printf 'PATH configured in %s\n' "$config_file"
  done
fi

# Each installation has its own runtime; the previous launcher remains usable.
release="$install_dir/releases/$version-$(basename "$stage")"
mv "$package" "$release"
launcher="$stage/launcher"
printf '#!/bin/sh\nexec %s "$@"\n' "$(quote "$release/laohuang")" > "$launcher"
chmod 755 "$launcher"
if [ -e "$bin/laohuang" ] || [ -L "$bin/laohuang" ]; then cp -p "$bin/laohuang" "$stage/previous"; mv "$stage/previous" "$bin/laohuang.bak"; fi
mv "$launcher" "$bin/laohuang"
printf 'Installed laohuang %s to %s\n' "$version" "$bin/laohuang"
if [ -n "${LAOHUANG_NO_MODIFY_PATH:-}" ]; then printf 'PATH modification skipped. Add %s to your PATH to use the command.\n' "$bin";
else printf 'Open a new terminal and run: laohuang\n'; fi
printf 'In this terminal, run:\n  %s\n  laohuang\n' "$path_line"
existing=$(command -v laohuang 2>/dev/null || true)
if [ -n "$existing" ] && [ "$existing" != "$bin/laohuang" ]; then printf 'Current PATH resolves to another installation: %s. Apply the PATH command above.\n' "$existing"; fi
