# laohuang

This npm package provides the `laohuang` command for
[laoHuangCode](https://pypi.org/project/laohuangcode/).

It is a small Node.js launcher, not a second implementation of the agent. On
first run it creates an isolated Python environment in the user cache and
installs the matching `laohuangcode` Python package. Python 3.11 or newer must
already be available as `python3` or `python`.

```bash
npm install --global laohuang
laohuang --version
laohuang config --provider deepseek
laohuang
```

The launcher accepts two advanced environment variables:

- `LAOHUANG_PYTHON`: run a specific Python executable and skip bootstrapping.
- `LAOHUANG_CACHE_HOME`: override the launcher's cache root.

See the main project README for model configuration and security details.
