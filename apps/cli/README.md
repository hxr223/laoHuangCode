# laohuang

A minimal coding-agent CLI for local software work.

## Install

Requires Node.js >=22.19.0.

```bash
npm install -g laohuang
```

## Usage

```bash
laohuang --help
laohuang --version
laohuang config set --provider deepseek --model deepseek-v4-flash
laohuang doctor
```

Run `laohuang` in a project directory to start an interactive session. The CLI
loads local project instructions, uses saved provider profiles, and keeps file
and shell tool execution rooted in the current project.
DeepSeek and OpenAI are the current product-supported model routes; additional
models visible through the installed pi-ai catalog are not support claims.

See the repository README for development and architecture details:
https://github.com/hxr223/laoHuangCode#readme
