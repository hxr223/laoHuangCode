# scripts/

This directory contains tests and repository automation only: build checks,
package/release checks, smoke tests, profiling, and statistics.

Do not put production Agent runtime behavior here. Runtime behavior belongs in
`apps/cli/src/` or the relevant `packages/<domain>/<package>/src/` workspace.
