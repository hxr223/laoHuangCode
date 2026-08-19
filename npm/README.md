# laohuang

This npm package provides the `laohuang` command for
[laoHuangCode](https://github.com/hxr223/laoHuangCode).

It is a small Node.js launcher, not a second implementation of the agent. On
first run it creates an isolated Python environment in the user cache and
installs the bundled `laohuangcode` Python wheel. Python 3.11 or newer must
already be available as `python3` or `python`. Third-party Python dependencies
are downloaded by pip during this first launch.

```bash
npm install --global laohuang
laohuang --version
laohuang
```

The first interactive launch asks for DeepSeek or OpenAI, reads the API key
with hidden terminal input, and then asks which model to use. No API key
environment variable is needed.

The launcher accepts two advanced environment variables:

- `LAOHUANG_PYTHON`: run a specific Python executable and skip bootstrapping.
- `LAOHUANG_CACHE_HOME`: override the launcher's cache root.

See the main project README for model configuration and security details.
