const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const packageJson = require("../package.json");

function cacheDirectory(env = process.env, version = packageJson.version) {
  let root = env.LAOHUANG_CACHE_HOME;
  if (!root) {
    if (process.platform === "darwin") {
      root = path.join(os.homedir(), "Library", "Caches", "laohuang");
    } else {
      root = path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "laohuang");
    }
  }
  return path.join(root, `python-${version}`);
}

function venvPython(venvDirectory) {
  return path.join(venvDirectory, "bin", "python");
}

function successful(result) {
  return !result.error && result.status === 0;
}

function findHostPython(env, spawnSync) {
  const candidates = env.LAOHUANG_BOOTSTRAP_PYTHON
    ? [env.LAOHUANG_BOOTSTRAP_PYTHON]
    : ["python3", "python"];
  const versionCheck =
    "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)";

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-c", versionCheck], {
      env,
      stdio: "ignore",
    });
    if (successful(result)) {
      return candidate;
    }
  }
  throw new Error("Python 3.11 or newer is required to run laohuang");
}

function runChecked(spawnSync, command, arguments_, options, description) {
  const result = spawnSync(command, arguments_, options);
  if (!successful(result)) {
    if (result.error) {
      throw new Error(`${description}: ${result.error.message}`);
    }
    throw new Error(`${description} (exit code ${result.status ?? "unknown"})`);
  }
}

function ensurePythonPackage({ env, spawnSync }) {
  const directory = cacheDirectory(env);
  const python = venvPython(directory);
  const readyFile = path.join(directory, ".laohuang-ready");
  if (fs.existsSync(python) && fs.existsSync(readyFile)) {
    return python;
  }

  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const hostPython = findHostPython(env, spawnSync);
  if (!fs.existsSync(python)) {
    runChecked(
      spawnSync,
      hostPython,
      ["-m", "venv", directory],
      { env, stdio: "inherit" },
      "Could not create the laohuang Python environment",
    );
  }

  const packageSource =
    env.LAOHUANG_PYTHON_PACKAGE || `laohuangcode==${packageJson.version}`;
  runChecked(
    spawnSync,
    python,
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--upgrade",
      packageSource,
    ],
    { env, stdio: "inherit" },
    `Could not install ${packageSource}`,
  );
  fs.writeFileSync(readyFile, `${packageJson.version}\n`, { mode: 0o600 });
  return python;
}

function run(
  arguments_,
  {
    env = process.env,
    spawnSync = childProcess.spawnSync,
  } = {},
) {
  const python = env.LAOHUANG_PYTHON || ensurePythonPackage({ env, spawnSync });
  const result = spawnSync(
    python,
    ["-m", "laohuangcode", ...arguments_],
    { env, stdio: "inherit" },
  );
  if (result.error) {
    throw new Error(`Could not start laohuang: ${result.error.message}`);
  }
  return result.status ?? 1;
}

module.exports = {
  cacheDirectory,
  ensurePythonPackage,
  findHostPython,
  run,
};
