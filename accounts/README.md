# Recite Al Quran accounts

V49 testing follow-up, at the owner's explicit request: **51 completed checks passed** (17 isolated headless Edge interface cases with a mock API, plus 34 actual-Worker JavaScript/SQL contract cases using in-memory Node SQLite). No account product fixes were needed. Native Miniflare/workerd execution was blocked before cases ran, and live tests were rejected before process creation, so these results do not verify the deployed route, production CPU limits, or completed Google authentication. No live test account was created and no cloud configuration changed. See [tests/README.md](tests/README.md) and the sanitized artifacts under `tests/artifacts/`. Local version badges are V49; nothing was pushed or deployed by the test batch.

V48 deployment status, October 17, 2026. The owner approved the password-account rollout. Migration `0002_password_accounts.sql` succeeded, a new private `PASSWORD_PEPPER` was created, and account Worker version `1eba00f9-be93-433b-b89c-c01a9e68f994` is deployed at 100% of traffic. Administrative binding metadata confirms both Google credentials and `PASSWORD_PEPPER` are `secret_text`, with the existing DB and APP_ORIGIN retained. No signup, password-login, recovery, browser, or microphone tests were run. **The owner reports successful live Google sign-in and saved-position restoration in the earlier release.** This is a separate Cloudflare Worker and D1 database for `recitealquran.com`; the static website continues to use its current Worker/build configuration and was not redeployed in this batch. Do not point the account Worker at the site's root URL, R2 model domain, or the old HafizAssist database.

Reuses the Google OAuth/OIDC approach from `Desktop-HafizAssist/accounts`, with new cookies, prefixed tables, and this app's Quran coordinates. It does not copy, change, or import the old app's users/progress. Using the same Google OAuth client lets the same Google identities sign in, but visitors still complete sign-in on this domain; old session cookies cannot transfer between domains.

## Confirmed setup on October 17, 2026

- The owner saved the Google redirect URI `https://recitealquran.com/api/account/callback` on the existing OAuth client.
- The owner created the separate D1 database `recitealquran-accounts`, with Database ID `bc19d842-ecb3-443a-b363-3a4e2b4d955b`. This ID is now recorded in this folder's `wrangler.jsonc`; it is an identifier, not a secret.
- Cloudflare browser authorization succeeded for account `ee6f807515a3090ba957c1983f0484ec`.
- Remote migration `0001_recite_accounts.sql` succeeded on the new D1 database.
- Account Worker `recitealquran-accounts` was deployed with D1 binding `DB`, origin `https://recitealquran.com`, route `recitealquran.com/api/account*`, and version ID `760a1430-f7a1-4d67-a602-5141940a5d5e`.
- The owner supplied the existing Google client credentials privately in Cloudflare and reports that live sign-in succeeds. On a second login, the app returns to the saved position. Credential values are not recorded in this repository or chat.
- The owner published the matching frontend in commit `6e215fc` (`Added Google oauth`). Sign-out, account deletion, device conflicts, and offline-to-online account synchronization have not been independently tested.

V42 configuration follow-up: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` were converted from plain Worker variables to encrypted Worker secrets without changing their working values. Cloudflare binding metadata confirms `secret_text` for both; `APP_ORIGIN` remains a plain configuration variable and `DB` remains the D1 binding. Credential values were not displayed, recorded in files, or committed. This configuration change did not include a new Google login or microphone test. The owner had already published the OAuth frontend and reported the login/resume result; no additional frontend release was published for this documentation/configuration batch.

## Username and password addition (deployed in V48)

The account service now also supports username/password accounts alongside Google. The owner approved migration `0002_password_accounts.sql`, private `PASSWORD_PEPPER` setup, and account Worker deployment in V48. The migration executed four commands successfully. The secret was generated with 32 cryptographically random bytes and transferred privately to Cloudflare, without displaying its value or saving it in project files. The service was published with `--keep-vars`; the existing Google secrets, database binding, origin, route, and daily cleanup schedule remain in place. This rollout adds password tables and does not migrate or reset existing Google identities or saved checkpoints. Missing password configuration advertises `passwordConfigured: false`; Google remains available. The owner already sees the username form on the site; reopening the app refreshes its account capability flags.

- A username has 3–32 ASCII letters, digits, or underscores. Leading/trailing whitespace is removed and usernames are stored lowercase, with an atomic unique database constraint. A password has 12–128 Unicode code points; spaces are accepted, no composition rule is imposed, and passwords are not trimmed, normalized, or truncated. Credentials are sent only in same-origin JSON request bodies over HTTPS, never URL parameters.
- Local IDs are `local:<random UUID>`, in a separate `recite_password_accounts` identity table. Existing Google subject IDs remain unchanged. A typed username does not establish a Google identity, and there is no automatic linking by email or browser checkpoint. Choosing another sign-in method can mean another account and another saved position.
- Password storage uses asynchronous native Web Crypto PBKDF2-HMAC-SHA-256 with 100,000 iterations and a fresh 256-bit random salt. Before PBKDF2, an HMAC-SHA-256 with the server-only `PASSWORD_PEPPER` processes the exact password. D1 stores salt, verifier, work factor, and credential version, not the password or pepper. Native Workers `timingSafeEqual` compares fixed-size verifiers. Workers caps native PBKDF2 at 100,000 iterations; this is a platform-constrained configuration, **not a claim to meet OWASP's 600,000-iteration PBKDF2 recommendation**. Keep the pepper private and separate from D1, and do not reduce the work factor to fit a CPU quota. Production hashing latency and Worker-plan capacity have not been measured in this batch.
- Signup returns a random 256-bit recovery code exactly once. Only its domain-separated SHA-256 hash is stored. The user must save the code privately. Recovery requires the username and code, replaces the password and recovery code atomically, and revokes all sessions for that account. A reused recovery code fails. There is no email collection or email-reset promise. If both password and recovery code are lost, the account cannot be recovered through this implementation; a fresh account does not inherit its saved progress.
- An authenticated local user can change a password only after providing the current password, with the normal account/CSRF headers. The change revokes all prior sessions and rotates the current browser into a fresh session. The recovery code stays unchanged for an ordinary password change. Google accounts continue to manage their password with Google.
- Signup/login/recovery are protected by exact same-origin `Origin` checks, JSON content type, and body limits. They do not require a preexisting CSRF token because they establish an initial session. All existing authenticated writes still require `X-Account-User` and `X-CSRF-Token`. Login errors do not reveal whether a username exists; unknown valid usernames perform the same KDF work. Signup can report a username as unavailable.
- D1-backed, atomic rate counters cover all credential endpoints together (80 attempts per IP per hour) plus individual actions. Login/change allow 30 per IP and 10 per username per 15-minute window; signup/recovery allow 5 per IP and 5 per username per hour. Both successes and failures count. Counter identifiers are HMACs, not raw IP addresses or attempted usernames; daily cleanup removes expired rows. Quotas persist across concurrent requests and Worker isolates. These controls do not replace edge protection against a large distributed attack.
- Conditional credential-version checks prevent an in-flight old-password login or parallel recovery from creating a valid session after a successful reset. Password changes and recovery leave the same user ID and checkpoint intact. Deleting a local account removes its password/recovery identity as well as its existing profile, progress, and sessions.

For future maintenance, preserve both Google secrets and the existing `PASSWORD_PEPPER`; password setup is now complete. Apply only pending migrations using the existing `npm run migrate` command in this folder. If installing this service in a genuinely new environment, create `PASSWORD_PEPPER` as a new **Cloudflare Worker Secret**, using at least 32 cryptographically random bytes (64 hex characters is suitable). Generate and transfer it privately: do not paste it into chat, source files, or a command argument visible in shell history. A secure operator script can feed the generated value directly into Wrangler's secret prompt. If this secret already exists, preserve it; rotating or losing it makes existing password verifiers unusable and invalidates rate-counter identities. Keep any operator backup private and separate from the database. No secret backup was written to this project during V48. No new Google client, D1 database, email service, or OAuth callback is required.

Deployment remains separate from source edits and the website's Git build. V48 deployed only this account Worker; local frontend badges are now V48 for the owner's next push. Server bundling was part of the approved deployment, not a validation build. Tests, browser/microphone checks, password account creation, and recovery attempts were not run. Active deployment `b0a92663-d070-4f17-9522-4df83dea5b4a` serves Worker version `1eba00f9-be93-433b-b89c-c01a9e68f994` at 100%.

## Deployment and configuration reference

The database, callback, account Worker, and frontend are already connected as described above. These instructions are retained for future maintenance; do not recreate the database or reset credentials unnecessarily. Nothing in this folder creates cloud resources or publishes itself.

1. Install Node.js and, from this `accounts` folder, install the listed dependencies and sign in to the Cloudflare account that owns the new database and `recitealquran.com`:

   ```powershell
   npm install
   npx wrangler login
   ```

   These are separate from the static site's build. Do not change that site's build output from `dist` or upload this folder as static assets. The account Worker bundles `jose` server-side; it is not delivered to the browser.

2. Configure **these secrets on the new `recitealquran-accounts` Worker**, privately, using the same existing Google OAuth client values:

   ```powershell
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   In Google Cloud, open **Google Auth Platform → Clients → the existing Web application OAuth client**. Copy its Client ID and existing Client secret only into the corresponding private prompts. If the new Worker is already listed in Cloudflare, the dashboard alternative is **Workers & Pages → recitealquran-accounts → Settings → Variables and Secrets → Add → Secret**: add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` with those exact names. Do not add them to the static website Worker (`myproject`) or the R2 bucket. If the account Worker is not listed yet, use the `accounts` folder's Wrangler setup rather than editing another Worker.

   Use private prompts, never HTML, source files, a screenshot, or chat. Secret values are not in the old repository and are not copied by this implementation. Do not reset the old client's secret without coordinating its existing deployment. Keep the previous HafizAssist redirect URI if that app is still in use. Update consent branding, authorized domains, support/privacy links, and audience for this site where required. A client left in Testing permits only its configured test users. Only `openid email profile` is requested; no Drive, Gmail, or microphone permission is requested from Google.

3. Apply this new database's migration and deploy only this account Worker:

   ```powershell
   npm run migrate
   npm run deploy
   ```

   Its only route is `recitealquran.com/api/account*`. The existing website Worker must continue serving all other paths, and the `model.recitealquran.com` R2 configuration remains unchanged. Keep `/api/account*` excluded from CDN cache rules and from the application's offline cache. Do not enable public `workers.dev` or preview URLs for accounts; the configured production origin is enforced on every request.

4. Publish future matching static frontend releases through the existing Cloudflare build. The owner chose to wait for sign-in before launching; live sign-in and saved-position restoration are now owner-reported as working. Broader promotion remains separate from these setup steps. Account isolation, sign-out/deletion, offline-to-online sync, and two-device conflict testing require the owner's explicit testing request under the project instructions.

The deployment dependencies are installed locally with the bundled pnpm runtime, including the required esbuild/workerd package setup. Cloudflare authorization, the new database migration, and the account Worker deployment were confirmed during setup. The matching frontend is owner-published; the owner's login/resume report is the evidence for those application flows. This is not a claim of an independent frontend deployment check or comprehensive account testing. No independent application tests or validation builds were run. Keep the old app's Worker, `APP_ORIGIN`, database, and credentials unchanged.

## Behavior and data

- Guests can keep practicing without an account. First Google sign-in needs a connection. A Python/Node static server alone does not run this Worker or D1; local guest tracking remains available while account actions report that the service is unavailable. Production callbacks require the deployed HTTPS domain.
- The account service stores either a Google subject ID, verified email and display name, or a local username with salted password/recovery verifiers. It also stores session hashes and one compact last-progress document per user. The document contains a page/surah/ayah/word position, Bismillah marker, correct/reviewed totals, and update time. It stores no microphone audio, recordings, raw phoneme output, transcripts, Teacher clips, per-word error history, preferences, or model files.
- Correct/reviewed totals describe the compact current practice snapshot, not a lifetime ledger or a recreated set of past word highlights. Resuming a saved position does not reconstruct prior error details. The frontend prompts before choosing a different account/browser position, and does not move an active recitation pointer automatically.
- All requests use same-origin cookies; there is no credentialed cross-origin API. Authenticated writes require the configured `Origin`, a valid session, and `X-CSRF-Token`. A fresh token is supplied after session creation/rotation and by the authenticated, uncached `/me` response. Progress reads and authenticated mutations also require `X-Account-User` to match the identity confirmed by `/me`; a cookie changed by another tab is rejected with `401`. This header only asserts the expected identity, never selects database ownership. Signup, password login, and recovery establish or recover a session, so use exact Origin/JSON checks and persistent rate limits without a prior session token. Google account ownership comes only from a verified ID token's `sub`, never from a browser-supplied user ID or email.
- OAuth uses a ten-minute single-use state tied to a secure HttpOnly cookie, PKCE S256, a nonce, issuer/audience/signature/expiry verification through `jose`, and allowlisted return paths. Google tokens remain server-side and are discarded after sign-in. A new login rotates the current browser's session.
- Session cookies are `__Host-` scoped, Secure, HttpOnly, SameSite=Lax, with a 30-day expiry. The database contains only hashes of session tokens. Daily scheduled cleanup removes expired login flows and sessions. HTTPS, the exact configured domain, and cookies are required.
- Saves are local-first on the frontend and use an atomic version check in D1. Concurrent device changes return `409` with the current cloud copy; the user chooses rather than silently overwriting it. The service does not trust client timestamps for ownership or conflict resolution.
- Sign-out revokes the current browser session. **Delete account** removes this site's cloud profile, progress, and every session for that identity, and clears its cookie. It does not delete the Google account or data in Desktop-HafizAssist. The frontend also clears the current account checkpoint in this browser after deletion; separately saved guest practice and downloaded app/model files remain. Other devices can retain their own local copies until those site data are removed.
- The account database has ongoing personal data until the user deletes it. Cloudflare database backups, restore/retention policy, plan quotas, and account service availability are operator responsibilities. Check applicable D1/Worker quotas and configure suitable edge abuse protection for `/api/account/login` before wider promotion; do not log OAuth codes, cookies, or user progress.

## Frontend API contract

All responses have `Cache-Control: private, no-store`. Error responses are JSON with an `error` message; credential errors also include a stable `code`. The service returns `503`/`configured:false` when the required origin/database configuration is absent; guests remain usable. `/me` separately advertises Google and password capability. No CORS headers are emitted.

| Method and path | Input | Response |
| --- | --- | --- |
| `GET /api/account/me` | Cookie | `{ configured: true, googleConfigured: boolean, passwordConfigured: boolean, user: { id, name, email, username, provider } \| null, csrfToken: string \| null }` |
| `GET /api/account/login` | Optional `returnTo` query | Redirect to Google; returns to the app with `?account=connected` or `?account=error` |
| `POST /api/account/register` | Same-origin JSON `{ username, password }` | `{ user, csrfToken, recoveryCode }` and fresh session cookie |
| `POST /api/account/password-login` | Same-origin JSON `{ username, password }` | `{ user, csrfToken }` and fresh session cookie |
| `POST /api/account/recover` | Same-origin JSON `{ username, recoveryCode, password }` | `{ recovered: true, recoveryCode }`; revokes all account sessions and expires current browser cookie; sign in again |
| `POST /api/account/password` | JSON `{ currentPassword, newPassword }`, cookie, `X-Account-User`, `X-CSRF-Token` | `{ user, csrfToken }`; replaces all account sessions with a fresh current-browser session |
| `GET /api/account/progress` | Cookie, `X-Account-User` | `{ progress: object \| null, version: number, updatedAt: number \| null }` |
| `PUT /api/account/progress` | JSON `{ expectedVersion, progress }`, cookie, `X-Account-User`, `X-CSRF-Token` | `{ version, updatedAt }`; stale version returns `409` with `{ error, progress, version, updatedAt }` |
| `POST /api/account/logout` | Cookie, `X-Account-User`, `X-CSRF-Token` | `{}` and expired session cookie |
| `DELETE /api/account/account` | Cookie, `X-Account-User`, `X-CSRF-Token` | `{}` and expired session cookie |

`/api/account/google` aliases `/login`; `DELETE /api/account` aliases the account deletion path. Google alone calls the callback. Allowed `returnTo` values are `/`, `/index.html`, `/mobile.html`, `/test.html`, and `/test2.html`; all other values become `/`. The root callback never accepts an arbitrary redirect URL.

`provider` is `google` or `password`; `username` is `null` for Google, and `email` is `null` for a local account. Credential error codes include `invalid_credentials`, `invalid_recovery`, `current_password_incorrect` (401), `username_unavailable` (409), `invalid_username`, `invalid_password`, `google_account` (400), `password_not_configured` (503), and `rate_limited` (429, with `retryAfter` seconds and a `Retry-After` header). Keep passwords and recovery codes out of console logs, analytics, and persistence; the one-time code is returned only for signup and successful recovery.

```json
{
  "schema": 1,
  "position": {
    "page": 2,
    "surah": 2,
    "ayah": 1,
    "word": 0,
    "bismillah": false
  },
  "totals": { "correct": 8, "reviewed": 10 },
  "updatedAt": 1792267200000
}
```

`word` is the actual word-position coordinate supplied by this tracker's Quran data, **not** a copied Desktop-HafizAssist cursor or a page array offset. The adapter resolves those coordinates on resumption. `page` is 1–604, `surah` 1–114, `ayah` 1–286, and `word` 0–300; Bismillah is identified separately. Only these whitelisted fields are persisted. `updatedAt` inside progress is the browser's local snapshot time; the envelope's `updatedAt` is the server save time. A missing cloud document has version `0`; every successful save increments the cloud version.

## References

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [Cloudflare Worker routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Cloudflare D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare Web Crypto, including timingSafeEqual](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Cloudflare workerd PBKDF2 iteration limit](https://github.com/cloudflare/workerd/issues/1346)
- [Cloudflare D1 transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [OWASP password storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

V42 final metadata check: active account Worker version `ccda630c-8c9f-4bc0-a5be-d7942af1446e` is deployed at 100%. Both Google credential bindings are `secret_text`, and `/api/account/me` returns `configured: true`. This confirms deployment/configuration; the completed Google login and restored position were reported by the owner.
