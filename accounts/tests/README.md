# Account tests

These checks were added at the owner's explicit request. They do not use the owner's browser profile, Google login, Cloudflare credentials, or production password secret.

## Local backend integration

The completed socket-free run used Node.js 24 and real in-memory SQLite. From the repository root:

```powershell
node accounts/tests/backend.test.mjs --node-sqlite
```

This imports the actual account Worker, adds Node's timing-safe comparison for the Cloudflare-specific API, and supplies a D1-style transaction adapter over SQLite. **34 cases passed, 0 failed.** It tests the JavaScript/SQL contract in one process, not native Cloudflare execution or distributed database scheduling.

The native Workers alternative is:

```powershell
node accounts/tests/backend.test.mjs
```

This bundles the actual account Worker and runs it in native workerd through Miniflare, with separate local D1 databases and fictional credentials. It uses the dependencies already installed under `accounts/node_modules/.pnpm`. This attempt was blocked before any case ran: the sandbox denied the localhost connection to workerd, and the permission retry was aborted. Both modes cover password identities, session/CSRF boundaries, progress ownership/conflicts, recovery and password-change races, persistent rate limits, deletion, and existing Google identities. Neither completes Google consent or a real Google token exchange, measures Cloudflare's production CPU quotas, or tests the live route.

## Isolated browser interface

```powershell
node accounts/tests/frontend-account-ui.mjs
```

Run from the repository root with Playwright installed, or set `PLAYWRIGHT_PACKAGE` to an installed Playwright package directory. The harness opens a fresh headless Microsoft Edge context and imports the actual account module and stylesheet. API responses are mocked, so it does not create production accounts. It covers desktop/mobile forms, recovery-code acknowledgment, initials, Arabic labels, busy-state controls, explicit resume, local queues, account isolation, expiry, and conflicts.

**17 cases passed, 0 failed** in the completed browser run. Afterward, the test runner's dependency path was made configurable and its dummy badge was renamed; those portability-only edits did not change the cases or product source. The attempted rerun was aborted at approval and supplies no additional result. On this machine, the bundled package can be selected with:

```powershell
$env:PLAYWRIGHT_PACKAGE = 'C:\Users\gufra\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
```

## Live integration — separate explicit opt-in

```powershell
node accounts/tests/live-accounts.mjs --live
```

This sends requests to `https://recitealquran.com`, creates one random temporary account, and deletes it afterward. Cookies, passwords, and recovery codes stay in process memory. It does not load the owner's browser cookies. It also checks the Google entry/cancellation routes without completing Google sign-in. This run counts toward normal live rate limits; do not run it repeatedly or in parallel. Without `--live`, the script exits before making requests.

The requested live run was rejected by the execution permission prompt before starting. No production test account was created. Local checks are reported separately; they do not establish that live signup/login succeeds.

Sanitized result artifacts, when available, are under `artifacts/`. They contain case names and results, not passwords, cookies, recovery codes, or private server configuration.
