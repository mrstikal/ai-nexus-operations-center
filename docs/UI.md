# NEXUS UI Shell

This document covers the F06 browser shell. It is the first real authenticated UI:
navigation, login/logout, account/sandbox/mode indicators, and the same-origin API
proxy. Case, approval, document, knowledge, dashboard and assistant screens remain
later work; F06 does not render placeholder versions of them.

## Public origin and proxy

The browser uses one public origin: the Next.js web application
(`http://127.0.0.1:3000` in local development). Browser code calls `/api/v1/...` on
that origin. The Next route handler in `apps/web/app/api/[...path]/route.ts` streams
each request to the fixed internal API origin configured by `NEXUS_API_ORIGIN`; the
default is `http://127.0.0.1:3001`.

- The upstream origin is server configuration and is never accepted from the browser.
  There is no `?url=`, host header, path rewrite or redirect fallback that can change it.
- Only paths under `/api/v1/...` are accepted. Path segments are bounded and may contain
  only letters, digits, `.`, `_`, `~` and `-`; dot segments are rejected.
- Methods are explicit (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`). Request bodies
  are streamed to the API with `duplex: 'half'`; response bodies are streamed back.
- Request headers are allowlisted: `accept`, `accept-language`, `content-type`,
  `cookie`, `origin`, `referer`, `sec-fetch-*`, `x-csrf-token` and `x-request-id`.
- Response headers are allowlisted: `cache-control`, `content-disposition`,
  `content-language`, `content-type`, `retry-after`, `vary`, `x-request-id`, plus every
  `Set-Cookie` value from the API.
- The API's session cookie is therefore set on the web origin and remains `HttpOnly`.
  Browser JavaScript never receives the session token, and no token is written to
  `localStorage` or `sessionStorage`.
- An unreachable API or proxy configuration error returns a redacted
  `application/problem+json` `DEPENDENCY_UNAVAILABLE` response. The proxy substitutes no
  other upstream.

`NEXUS_ALLOWED_ORIGINS` on the API must contain the exact web origin used by the
browser. CORS is not used as a CSRF defence; Origin, Fetch Metadata and the CSRF token
are validated by the API as described in [SECURITY.md](SECURITY.md).

## Visual language

- Light neutral work area, dark navigation rail, compact typography and restrained
  density. The system font stack is used; no font CDN or external asset is loaded.
- Blue communicates investigation/information, amber review or read-only state, red a
  failed/blocked state, and green only a confirmed success. Every status badge includes
  text and a non-color icon/dot; color is never the only signal.
- Desktop uses a persistent left rail. At 768px the rail becomes a compact sticky top
  bar with horizontal primary navigation. At 360px the shell remains a single column,
  cards and detail lists stack, and bounded content may scroll horizontally rather than
  forcing the page wide.
- Focus-visible outlines are always shown, a skip link precedes the rail, and primary
  navigation uses `nav`/`aria-current`.

## Shell content

The rail and top bar show:

- the NEXUS/Northstar identity and the persistent **Replay** badge with
  "No live model calls";
- the signed-in display name, username, roles and session expiry;
- the server-resolved active sandbox name, status and simulated business date;
- the current navigation item and a sign-out control.

The overview is deliberately honest: it shows the authenticated session and sandbox
plus an empty-state note that no cases exist in this phase. It never renders a fake
case list, approval button or assistant. Future navigation entries stay hidden until
their owning stage adds a working screen.

## Login and session UX

- Anonymous access to `/` redirects to `/login` without fetching or rendering account,
  sandbox, case or evidence data.
- The login form obtains a single-use pre-authentication CSRF challenge through the
  proxy with browser credentials omitted, submits username/password with `X-CSRF-Token`
  to the real API, and relies on the API-issued `HttpOnly` session cookie. Omitting
  cookies keeps the challenge pre-authentication even when a stale login tab is open
  after another tab has signed in, so that tab can still authenticate instead of
  receiving a rotated session token that login cannot consume. The CSRF token exists
  only in the current form submission and is never persisted in browser storage.
- Sign-out rotates the session CSRF token and posts to the real logout endpoint. A
  successful logout clears the cookie and returns the browser to `/login`. Duplicate
  clicks are blocked synchronously; if another tab rotates the challenge first, the
  client re-checks the session and retries the challenge/logout exchange up to three
  times. A persistent non-CSRF rejection keeps the API's actual reason, and a final
  liveness check sends a tab to `/login` when its peer already completed sign-out.
- A `503` from login or sign-out is classified by the API problem message: mutation
  admission failures are shown as explicit read-only cache states, while identity
  storage failures are shown as identity-service errors and do not claim that reads
  continue.
- Refreshing an authenticated page re-reads `/api/v1/auth/me` and `/api/v1/sandbox`
  with the cookie forwarded server-side.
- Login failures are generic. Rate limiting, validation, origin and CSRF failures show a
  bounded error without echoing passwords, tokens or digests.
- An authenticated account without the required viewer role sees an explicit **403**
  access-denied state and no sandbox content.

## Honest states

| State | UI behavior |
|---|---|
| Loading | A loading feedback panel with live status text; no invented data. |
| Empty | The overview states that no cases exist yet and names the later owning stage. |
| Error | The error boundary shows a retry control and a redacted message, never a stack trace or secret. |
| Unavailable | A full-page shell-unavailable panel when the API or identity read is unreachable; an identity-store 503 is described as an identity-service outage, not as read-only. |
| Read-only | A verified session remains visible, but unavailable mutation admission is labeled read-only; mutations fail closed and are not silently claimed to have succeeded. |
| Forbidden | A 403 from the sandbox read shows access denied with the authenticated account and roles only. |

When Valkey (login/mutation admission) is unavailable, authenticated reads may continue
against PostgreSQL while login and sign-out fail closed with an explicit read-only
message. The UI does not claim that a failed mutation succeeded.

## Accessibility and responsive checks

- Login fields have labels and autocomplete hints; the username receives initial focus.
- Keyboard order reaches username, password, submit, skip link, primary navigation and
  sign-out. Activating the skip link targets the main region.
- Layout checks cover 1440px and 360px widths, including no page-level horizontal
  overflow at 360px.
- Reduced-motion preferences disable transitions.
- The browser test records every request and fails on an external origin, on a client
  bundle/source map containing server secrets or server-only environment names, and on
  any session token in browser storage.

## Verification

```bash
pnpm test:e2e F06
pnpm verify:phase F06
pnpm docs:check
```

The F06 E2E runner starts isolated PostgreSQL/Valkey test resources, applies migrations,
seeds disposable test accounts, starts the real compiled API and web app, and removes its
Compose project after the run. No model, paid call, external font or external telemetry
service is used.
