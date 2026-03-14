# Changelog — openauthster-issuer-server

## v0.3.1 — 2026-03-13

### Bug Fixes

#### Critical
- **TOTP setup expiry check was inverted** — `new Date(created_at).getTime() - Date.now() > TOTP_TOKEN_EXPIRATION_MS` was always false because `created_at` is in the past. Setup tokens never expired, leaving the 5-minute window permanently open. Fixed to `Date.now() - new Date(created_at).getTime()`. (`src/endpoints/index.ts`)
- **Password uppercase validation rule was inverted** — `password.toLocaleUpperCase() === password` evaluated to `true` for all-uppercase passwords (e.g., `"HELLO"`), making strong passwords fail and weak ones pass. Fixed to `password === password.toLocaleLowerCase()`. (`src/providers-setup.ts`)

#### Security
- **`/clear-cache/:key` was unauthenticated** — Any anonymous request could flush the project cache for any key, forcing a D1 round-trip on the next request and enabling cache-timing attacks. The endpoint now requires a valid admin secret header. (`src/endpoints/index.ts`)
- **Session-sensitive cookie values logged on every request** — `console.log({ cookies: { clientID, copyID, inviteID }, url })` emitted `clientID`, `copyID`, and `inviteID` to Workers Logs on every HTTP request. The log statement has been removed. (`src/endpoints/index.ts`)
- **OTP verification codes logged to console** — `console.log("Sending code ${code} to ${to} via Resend")` and similar statements exposed live authentication codes in Workers Logs. All code values have been removed from log output. (`src/providers-setup.ts`)
- **Session cookies missing `secure` and `sameSite` attributes** — `clientID`, `copyID`, and `inviteID` cookies were set with `httpOnly: true` only. All `setCookie` calls now include `secure: true, sameSite: "lax"`. (`src/endpoints/index.ts`)
- **Empty `X-Client-Signature` header caused unhandled 500** — `signature.match(/.{1,2}/g)!.map(...)` threw a `TypeError` when the signature was an empty string. Now returns a `401` with `invalid_signature` before attempting to parse. (`src/endpoints/shared.ts`)

#### High
- **`/session/*` middleware silently swallowed unexpected exceptions** — If `ensureToken` threw any non-`PartialRequestError`, the catch block called `next()` with `userInfo` unset, causing a downstream `TypeError` and creating a latent authentication bypass path. Unknown errors are now re-thrown. (`src/endpoints/index.ts`)
- **`mfa_setup` webhook fired before TOTP was confirmed** — The event triggered on `POST /totp/setup`, generating false-positive events for abandoned setups. The trigger has been moved to `POST /totp/confirm`, after successful code verification. (`src/endpoints/index.ts`)
- **`inviteHelper.removeInviteLinkById(null!)` called on every login** — For non-invite logins, `params.inviteID` is `null`. A `DELETE WHERE id = null` was being executed against D1 on every successful authentication. Now guarded with an explicit `if (params.inviteID)` check. (`src/endpoints/index.ts`)
- **QR provider dynamic `.ts` import failed in production bundle** — `import("../src/endpoints/index.ts")` referenced a TypeScript source file that does not exist after bundling. Import path restructured to use the compiled module. (`src/providers-setup.ts`)

### New Features

- **`login_attempt` webhook is now triggered** — Fires at the start of `getOrCreateUser` after the provider identity is parsed, covering all authentication flows that successfully reach the issuer's success callback. Payload includes `{ identifier, provider }`. (`src/endpoints/index.ts`)
- **`password_reset` webhook is now triggered** — Fires inside the `PasswordUI.sendCode` callback whenever a password reset code is dispatched. Looks up the user by email to include their `userID` in the payload. (`src/providers-setup.ts`)
