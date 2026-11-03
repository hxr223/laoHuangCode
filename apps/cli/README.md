# laohuang

A minimal coding-agent CLI for local software work.

## Install

Recommended standalone install (bundled Node.js; Bash required):

```bash
curl -fsSL https://github.com/hxr223/laoHuangCode/releases/latest/download/install.sh | sh
```

On Windows, install Git for Windows first, then run in PowerShell:

```powershell
irm https://github.com/hxr223/laoHuangCode/releases/latest/download/install.ps1 | iex
```

The installer verifies the download and startup, then configures the user PATH.
Open a new terminal or apply the PATH command printed by the installer.
Standalone packages target macOS, glibc Linux and Windows on x64 and ARM64.
See [installation details](https://github.com/hxr223/laoHuangCode/blob/main/INSTALLING.md).

Alternatively, install with npm (Node.js >=22.19.0 and Bash required; npm's
global executable directory must already be on PATH):

```bash
npm install -g laohuang
```

## Usage

```bash
laohuang --help
laohuang --version
laohuang config set --provider deepseek --model deepseek-flash
laohuang doctor
laohuang update
```

Run `laohuang` in a project directory to start an interactive session. The CLI
loads local project instructions, uses saved provider profiles, and keeps file
and shell tool execution rooted in the current project.

Model providers come from the installed pi-ai API-key catalog. In pi-ai 1.0.0
the product exposes 38 available chat API-key providers, excluding Amazon Bedrock,
Google Vertex, OAuth-only providers, OpenAI Codex, and operation-only catalogs.
`deepseek-flash` is the built-in DeepSeek V4.1 Flash model. Use `/providers` to see
available, configured, and verified status independently.

`/login <provider>` stores API-key credentials, `/logout <provider>` removes
them, and `/model` opens a searchable list of all available models from
configured providers, including credentials supplied through environment variables.
Search by provider ID, model ID, or model name; scroll to browse the full list.
If no models are available, the CLI points to `/login`.
`/model <provider>` narrows the list, `/model <provider> <model>` switches
directly, and `/apikey` remains a compatibility alias. Switching models affects
only the current session, not the default profile.

For standalone installations, `laohuang update` reruns the bundled installer
against the latest GitHub release, verifies it before switching the launcher,
and retains the previous version. Restart laohuang after updating.

For npm installations, `laohuang update` updates the running installation to the latest stable
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

## Code Mode

Use `/codemode off|on|only` for the current session and `/codemode default off|on|only`
for new sessions. Default is off. On keeps direct calls and JavaScript composition;
only disables ordinary direct calls and `tool_search`. Changes apply to the next model request.
Scripts use `await searchTools(query)`, `await tools.name({...})`, `text`, `console`,
`image`, `store`/`load`, and top-level return. Intermediate results stay private;
only explicit output and a successful return reach the model. State commits on success
or `exit()` and survives branch restore; failures do not commit state or roll back tool effects.

An optional first line `// @options: {"timeout_ms":30000,"max_output_tokens":10000}`
sets a total deadline and approximate text budget. Default deadline is unlimited.
Two shared Workers serve FIFO waiters, with a 60 second queue limit. QuickJS heap is
limited to 256 MiB, output to 16777216 UTF-16 characters or 100000 items, and store
to 262144 JSON characters per value / 1048576 including keys overall. The default
model text budget is 10000 tokens at four characters each; full selected text is
saved under `codemode-artifacts/<sessionId>` beside config when preview is truncated.
Only selected images are exposed. QuickJS isolates scripts; host tools retain user permissions.

## MCP

MCP is built in. Put a version 1 `mcp.json` beside your model `config.json`, or
in `.laohuang/mcp.json` under the directory where you start the CLI:

```json
{
  "version": 1,
  "servers": {
    "local": {
      "transport": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-server.js"]
    }
  }
}
```

Transports are `stdio`, Streamable `http`, and legacy `sse`. Use `/mcp status`,
`/mcp reload`, `/mcp reconnect <server>`, `/mcp login <server>`, and
`/mcp logout <server>`. Remote OAuth uses `auth: { "type": "oauth" }`.
Environment references use `{ "env": "VARIABLE_NAME" }`; no shell expansion occurs.
Project entries replace same-name global entries entirely. Invalid files are
skipped on startup; an invalid reload keeps the previous configuration.

Connections start in the background; the first model request waits for initial
discovery. Below 20 available tools, definitions are provided in full. At 20 or
more, `tool_search` automatically searches and loads MCP tools; read, write,
edit and bash remain directly available. Search is local BM25 with query and
limit (default 8, range 1–20). Loaded definitions persist in retained session
history; after compaction removes them, search loads them again. The model can
start OAuth through a synthetic authenticate tool; the terminal shows a URL
immediately and waits up to 15 minutes for the user to finish authorization.
Tool calls default to sequential execution. Recoverable network errors allow
at most three application-level attempts; lost responses can cause duplicate
side effects. Cancellation, timeouts and business errors are not retried.
Large outputs and media
are retained under `mcp-artifacts` beside the global configuration; returned
paths let you retrieve them. Media files are not native image/audio model input.
MCP processes run with your user permissions and are not sandboxed.

See the repository README for development and architecture details:
https://github.com/hxr223/laoHuangCode#readme
