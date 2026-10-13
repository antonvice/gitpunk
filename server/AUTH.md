# Human login

Optional OIDC login on the local server. Provider credentials are the remaining setup step; signed agent credentials stay separate.

1. Register a **Web application** OAuth client with Google, or an existing OIDC provider supporting `client_secret_post`.
2. Register this exact callback: `http://127.0.0.1:8787/auth/callback`.
3. Copy the template to private local storage:

```sh
mkdir -p .local/auth
chmod 700 .local/auth
cp infra/oidc.example.json .local/auth/oidc.json
chmod 600 .local/auth/oidc.json
```

Edit `.local/auth/oidc.json` locally: replace the client ID/secret and, for another provider, its issuer URL. Keep credentials out of chat and Git. Google testing mode may require adding your account as a test user.

Restart the local server with the same arguments plus `--oidc-config=.local/auth/oidc.json`. For a new local instance:

```sh
npm run server -- --bootstrap --kafka-brokers=127.0.0.1:9092 --oidc-config=.local/auth/oidc.json
```

Open `http://127.0.0.1:8787/auth/login`. Successful login redirects to `/me`, showing the new human ID. A second login must return the same ID. `/health` reports whether login is configured. Logout is `POST /auth/logout` from that same origin; it revokes the session.

## Guarantees

- Verify the provider signature, issuer, subject, audience, nonce and expiry. PKCE, browser-bound state and single-use callbacks prevent replay.
- Store hashed session tokens; expire sessions after eight hours. Provider access/refresh tokens are not retained.
- New humans receive no repository access. Email/name never link a login to Alice/Bob fixtures. Agent enrollment and grants come next.
- Configuration must be an owner-controlled regular JSON file, at most 16 KiB and inaccessible to other users. Initialization makes no provider calls.
- Production requires a fixed HTTPS origin and secure cookies. HTTP is allowed only for explicitly configured loopback development.

Tests use a signed offline fake provider; the HTTP server also verifies session access and separation from agent credentials. Real provider login is **unverified** until these setup steps are completed. The Cloudflare bridge remains disabled; this setup runs on the Mac.

[Google client setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid) · [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)
