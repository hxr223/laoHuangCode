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

Model providers come from the installed pi-ai API-key catalog. In pi-ai 0.83.0
the product exposes 35 available API-key providers, excluding Amazon Bedrock,
Google Vertex, OAuth-only providers, and OpenAI Codex. Use `/providers` to see
available, configured, and verified status independently.

`/login <provider>` stores API-key credentials, `/logout <provider>` removes
them, `/model <provider> <model>` switches the session, and `/apikey` remains a
compatibility alias. `verified` means an explicitly authorized live native
tool-call/tool-result E2E was recorded; no providers are checked in as verified
by default.

See the repository README for development and architecture details:
https://github.com/hxr223/laoHuangCode#readme
