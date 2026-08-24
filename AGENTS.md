# Development Rules

## Conversational Style

- Keep answers short and direct.
- Technical prose only; avoid filler.
- No emojis in commits, issues, PR comments, or code.
- When the user asks a question, answer it first before editing or running implementation commands.
- When responding to user feedback or analysis, explicitly say whether you agree or disagree before saying what changed.
- During feature discussions, do not recommend first-version, throwaway, or partial-product approaches; treat this project as a complete product in progress and recommend paths that preserve a coherent end-state.

## Project Shape

- This is a TypeScript/Node.js CLI package named `laohuang`.
- Source lives in `src/`; tests live in `test/`.
- The npm package is built from `src/` into `dist/` with `tsc`.
- Do not treat old Python build artifacts, `build/`, `src/laohuangcode.egg-info/`, `__pycache__/`, or `npm/vendor/` as primary source unless the user explicitly asks about them.
- Do not edit generated or packaged artifacts such as `dist/`, `build/`, egg-info, or vendored release files unless the task is specifically about packaging or release output.

## Code Quality

- Read files in full before broad changes, audits, or edits to files you have not already inspected.
- Prefer the existing architecture and naming in this repo over introducing new abstractions.
- Use strict TypeScript. Avoid `any` unless there is no reasonable typed alternative.
- Do not guess external API types; inspect local dependency types in `node_modules` when needed.
- Use top-level imports. Do not use inline dynamic imports or dynamic type imports unless the runtime behavior specifically requires them.
- Keep TypeScript syntax erasable in files run directly by Node tests: no `enum`, `namespace`/`module`, parameter properties, `import =`, or `export =`.
- Inline single-use one-line helpers.
- Ask before removing behavior or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.

## Commands

- After code changes, run:

  ```bash
  npm run build
  npm test
  ```

- If you create or modify a specific test file, run that test and iterate until it passes. Use the full `npm test` before claiming the overall code change is verified.
- Do not run provider calls or tests that require real API keys unless the user explicitly asks.
- For ad-hoc scripts, write them to `/tmp`, run them, then remove them. Do not embed long multi-line scripts directly in shell commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat `package.json` and `package-lock.json` changes as reviewed code.
- Prefer `npm ci --ignore-scripts` for local hydration.
- If dependency metadata changes, refresh the lockfile with `npm install --package-lock-only --ignore-scripts`.
- Do not run lifecycle scripts unless the user asks.
- Do not add new dependencies unless they clearly reduce risk or complexity.

## Git

Multiple agent sessions may be working in this repository. Git operations must not touch unstaged, staged, or untracked files outside your own changes.

When committing:

- Only commit files changed in this session.
- Stage explicit paths only, for example `git add src/foo.ts test/foo.test.ts`.
- Never use `git add .` or `git add -A`.
- Before committing, run `git status` and verify that only your files are staged.
- Use concise messages such as `fix: handle cancelled tool output` or `feat: add model adapter boundary`.

Never run:

- `git reset --hard`
- `git checkout .`
- `git clean -fd`
- `git stash`
- `git add .`
- `git add -A`
- `git commit --no-verify`

If rebase or merge conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Testing Interactive Mode

For terminal behavior, prefer a controlled tmux session from the repo root:

```bash
tmux new-session -d -s laohuang-test -x 80 -y 24
tmux send-keys -t laohuang-test "node dist/cli.js" Enter
sleep 3 && tmux capture-pane -t laohuang-test -p
tmux send-keys -t laohuang-test "your prompt here" Enter
tmux send-keys -t laohuang-test Escape
tmux kill-session -t laohuang-test
```

Build first with `npm run build` before running `node dist/cli.js`.

## Security Boundaries

- This agent has direct `read`, `write`, `edit`, and `bash` tools.
- `bash` has no OS-level sandbox. Be careful with commands that read secrets, access the network, or modify files outside the repo.
- Tests should use fakes or local fixtures, not real provider credentials or paid API calls.
- API key behavior and tool safety are documented in `docs/security.md`; read it before changing credentials, tool execution, or web event logging.

## Publishing

- This project publishes only an npm package; there is no PyPI or wheel release path.
- Follow `docs/publishing.md` for version and release work.
- Before release-related changes, run the full local check from that document:

  ```bash
  npm ci
  npm run build
  npm test
  npm pack --dry-run
  ```

- Do not publish manually unless the user explicitly asks.

## User Override

If the user's instruction conflicts with this file, ask for explicit confirmation before overriding it.
