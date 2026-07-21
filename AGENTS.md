# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An OpenCode plugin (`@gchamon/opencode-kiro-auth`) that authenticates against AWS Kiro
(CodeWhisperer / Q Developer) and exposes Claude models through OpenCode's
`@ai-sdk/openai-compatible` provider. This repo is a fork (`gchamon/opencode-kiro-auth`)
of `tickernelz/opencode-kiro-auth`.

## Commands

```bash
npm run build       # tsc -p tsconfig.build.json + scripts/fix-esm-imports.mjs → dist/
npm run typecheck   # tsc --noEmit
npm test            # bun test (tests live in src/__tests__/)
bun test src/__tests__/effort.test.ts        # run a single test file
bun test --test-name-pattern "pattern"       # run tests matching a name
npm run format      # prettier --write 'src/**/*.ts'
```

Tests require Bun (they use `bun:test`). Husky + lint-staged run prettier on staged
`.ts` files at commit time.

Local plugin testing: point `opencode.json`'s `plugin` array at this repo's absolute
path, then `npm run build` and restart OpenCode — OpenCode loads `dist/`, not `src/`,
so changes are invisible until rebuilt.

## Versioning & releases

Every push to `master` is evaluated for a new release by CI. Write **conventional commit**
messages so the auto-semver tagger bumps correctly:

| Prefix | Bump | Example |
|--------|------|---------|
| `feat:` | minor | `feat: add sonnet 5 support` |
| `fix:`, `perf:`, `refactor:`, `test:`, `chore:`, `docs:`, `style:`, `ci:`, `build:`, `revert:` | patch | `fix: handle null profileArn` |
| `BREAKING CHANGE:` in body | major | `feat: rewrite auth\n\nBREAKING CHANGE: ...` |

Plain messages (no prefix) won't trigger a version bump. Any conventional commit
prefix produces a bump. After merge, the pipeline
builds `dist/`, commits it, pushes a semver tag (e.g. `v1.12.0`), moves the floating
`v1` tag, and creates a GitHub Release with auto-generated changelog notes.
Users should pin `v1` in `opencode.json`, not a specific patch version.

## Build/ESM gotcha

`tsconfig.json` uses `module: Preserve` / `moduleResolution: bundler`, so source files
import relative paths with or without `.js` extensions inconsistently. The postbuild
script `scripts/fix-esm-imports.mjs` rewrites relative imports in `dist/` to add `.js`
extensions for strict ESM runtimes. Don't "fix" extension inconsistency in `src/` for
its own sake, and keep the postbuild step in mind if imports break at runtime but
typecheck fine.

## Architecture

Entry points: `index.ts` (package root re-exports) and `src/index.ts` (default export
consumed by OpenCode). `src/plugin.ts` is the actual plugin factory (`createKiroPlugin`)
and wires everything together. It returns three OpenCode hooks:

- **`config`**: injects the `kiro` provider into OpenCode config — sets
  `npm: '@ai-sdk/openai-compatible'`, the regional base URL, and default model
  definitions. Also calls `bootstrapAuthIfNeeded` to plant a placeholder `kiro` entry in
  OpenCode's `auth.json` so the auth loader runs on startup (needed for Kiro CLI
  Google/GitHub OAuth users).
- **`auth.loader`**: initializes `AuthHandler` (syncs accounts from Kiro CLI's SQLite
  db if `auto_sync_kiro_cli`) and returns a **custom `fetch`** — this is the core trick:
  all model traffic from the openai-compatible provider is intercepted by
  `RequestHandler.handle`, which serializes Kiro requests through a static promise
  queue and rewrites them into CodeWhisperer calls.
- **`provider.models`**: normalizes model definitions so every model has
  `api.npm`/`api.url` set.

### Request pipeline (`src/core/request/`)

`RequestHandler.handleKiroRequest` orchestrates per-request: account selection
(`core/account/account-selector.ts`, strategies: `sticky` / `round-robin` /
`lowest-usage`), token refresh (`core/auth/token-refresher.ts`), request transformation,
send, then response transformation or error handling. Supporting pieces:

- `src/plugin/request.ts` — transforms the OpenAI-style chat body into a
  CodeWhisperer request, using `src/infrastructure/transformers/` (history builder,
  message merger, tool converter, image handler).
- `src/core/request/response-handler.ts` + `src/plugin/streaming/` — parse the AWS
  event stream and convert it back into OpenAI-compatible (streaming) responses,
  including extracting thinking/tool-call content from Kiro's tag format.
- `src/core/request/error-handler.ts` + `retry-strategy.ts` — rate-limit backoff,
  account health marking/rotation, and gradual context truncation on error 400.
- `src/core/account/usage-tracker.ts` — quota sync and toast notifications.

There are two send paths: raw HTTP against `q.{region}.amazonaws.com` and the AWS SDK
path via `@aws/codewhisperer-streaming-client` (`src/plugin/sdk-client.ts`,
`streaming/sdk-stream-transformer.ts`).

### Auth & account sync

- `src/kiro/oauth-idc.ts` + `src/core/auth/idc-auth-method.ts` — device-code OAuth for
  AWS Builder ID and IAM Identity Center (custom Start URL); no local auth server.
- `src/plugin/sync/kiro-cli.ts` — imports active sessions (tokens, OIDC client
  registration, profile ARN) from the local `kiro-cli` SQLite database.
- Accounts persist in libsql SQLite at `~/.config/opencode/kiro.db`
  (`src/plugin/storage/sqlite.ts`, WAL mode, migrations in `storage/migrations.ts`,
  cross-process safety via `proper-lockfile` in `locked-operations.ts`). An in-memory
  `AccountCache` fronts the `AccountRepository` (`src/infrastructure/database/`).

### Model & effort mapping

- `src/constants.ts` — `MODEL_MAPPING` maps OpenCode model IDs (e.g.
  `claude-opus-4-8-thinking`) to Kiro model IDs (`claude-opus-4.8`); `-thinking` and
  `-1m` variants are virtual models that share a base Kiro model. Adding a new model
  means updating `MODEL_MAPPING`, the defaults in `src/plugin.ts`, and the README's
  example config.
- `src/plugin/effort.ts` — maps OpenCode `thinkingBudget` values to Kiro's native
  `effort` enum; capability sets (`EFFORT_CAPABLE_MODELS`, `XHIGH_CAPABLE_MODELS`)
  gate which models get the field and clamp unsupported levels.

### Configuration

Runtime plugin config is user-side JSON at `~/.config/opencode/kiro.json`, validated
by the zod schema in `src/plugin/config/schema.ts` and loaded in
`src/plugin/config/loader.ts`. Config options are documented in the README — keep the
schema and README in sync when adding options.

## Release pipeline

`.github/workflows/release.yml` runs on every push to master: typecheck + build, then
computes the next semver from conventional-commit prefixes since the last tag
(`feat:` → minor, `fix:`/`chore:`/etc. → patch, `BREAKING CHANGE` → major; other
messages cut no release). It commits `dist/` on a **detached commit reachable only via
the release tags** (`vX.Y.Z` plus the force-moved floating `v1`) and creates a GitHub
Release, and publishes `@gchamon/opencode-kiro-auth` to npm via Trusted Publishing
(OIDC; configured on npmjs.com, no token secret). `dist/` must never be committed to
master — OpenCode installs plugins via npm Arborist with `ignoreScripts: true`, so
whatever users install (the npm package, or the `#v1`/`vX.Y.Z` git tags) must contain
prebuilt `dist/`; build-on-install is impossible. npm is the recommended install spec
(OpenCode caches registry packages by name — fast startup); git specs re-resolve on
every startup and are slow.
