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
laohuang update
```

Run `laohuang` in a project directory to start an interactive session. The CLI
loads local project instructions, uses saved provider profiles, and keeps file
and shell tool execution rooted in the current project.

Model providers come from the installed pi-ai API-key catalog. In pi-ai 0.83.0
the product exposes 35 available API-key providers, excluding Amazon Bedrock,
Google Vertex, OAuth-only providers, and OpenAI Codex. Use `/providers` to see
available, configured, and verified status independently.

`/login <provider>` stores API-key credentials, `/logout <provider>` removes
them, and `/model` opens a searchable list of all available models from
configured providers, including credentials supplied through environment variables.
Search by provider ID, model ID, or model name; scroll to browse the full list.
If no models are available, the CLI points to `/login`.
`/model <provider>` narrows the list, `/model <provider> <model>` switches
directly, and `/apikey` remains a compatibility alias. Switching models affects
only the current session, not the default profile.

`laohuang update` updates the running npm installation to the latest stable
release and verifies its installed version. Restart the CLI after updating.
It supports global npm installations and direct project or workspace npm
dependencies; local updates change the owning manifest and lockfile while
preserving the dependency bucket and ordinary version-prefix style. It does
not downgrade or update a different installation. Source checkouts, linked
packages, temporary npx installations, and other package managers require
their respective update methods. Installation failures are reported without
claiming that npm rolled back changes.

`/name MCP design` saves the current session name, and `/name` displays it.
Names survive resume and appear in session lists. Clones inherit the current
name; forks inherit the name at their history boundary.

`/copy` copies the latest recorded assistant response's text with its Markdown
intact, excluding reasoning and tool results. During streaming it copies the
previous recorded response. Local sessions use the operating system clipboard;
SSH sessions send an OSC 52 request to the user's terminal. A sent request is
not confirmation that the terminal accepted it. Unsupported environments or
clipboard failures produce an explanatory message.

`verified` means an explicitly authorized live native
tool-call/tool-result E2E was recorded; no providers are checked in as verified
by default.

See the repository README for development and architecture details:
https://github.com/hxr223/laoHuangCode#readme
