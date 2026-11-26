# Nettle Group API — Neon Functions

The public site remains on GitHub Pages at `https://www.nettlegroup.space/`. The API is deployed to the existing Neon project `nettlegroup`, database `nettle_main`. No additional hosting provider is used for the API.

## Current deployment

- Neon project: `dry-shape-51006688`
- Main branch: `br-little-union-b9iipjfz`
- Function slug: `nettleapi`
- Active deployment: `60` (Node.js 24, completed 2026-11-26)
- Native invocation URL: `https://br-little-union-b9iipjfz-nettleapi.compute.c-7.eu-central-1.aws.neon.tech/`
- Custom domain: `api.nettlegroup.space` (Neon reports binding active and DNS status OK)
- `DATABASE_URL` is injected by Neon.
- Runtime environment includes `SITE_ORIGIN`, `INITIAL_ADMIN_TELEGRAM_ID`, `SESSION_SECRET`, and `TELEGRAM_BOT_TOKEN`. Values are stored as secrets and must never be copied into source control.
- Private Neon Object Storage bucket: `euromix-media`.

## Telegram sign-in

The existing Telegram Login Widget is used through `euromix-login.html` at `https://www.nettlegroup.space/euromix-login.html`.

1. In @BotFather, verify that the Telegram Login Widget domain is configured as `www.nettlegroup.space`.
2. Keep `TELEGRAM_BOT_TOKEN` in the Neon Function environment. Never put it in Android resources, JavaScript, or GitHub source.
3. The web page posts the Telegram widget payload to `POST /api/auth/telegram`. The API validates the Telegram signature and sets the existing HttpOnly session cookie.
4. The page requests `POST /api/auth/mobile/code`. The API creates a cryptographically random one-time code, stores only its SHA-256 hash, and expires it after 90 seconds.
5. The page returns to Android with `euromix://auth/success?code=...`.
6. Android redeems the code at `POST /api/auth/mobile/exchange`. The code is consumed atomically and can be used once. The API returns a signed 30-day Bearer token with audience `euromix`.
7. Android stores the token encrypted with an Android Keystore AES key. `GET /api/session` returns the current server-side role; client-side state is not an authorization source.

The `euromix_auth_codes` table is defined in `database/migrations/2026-11-26-euromix-auth-codes.sql` and in the baseline `database/schema.sql`.

## API routes

- `POST /api/auth/telegram`, `POST /api/auth/logout`, `GET /api/session`
- `POST /api/auth/mobile/code`, `POST /api/auth/mobile/exchange`
- `GET /api/services`, `GET /api/payment-methods`
- `GET/POST /api/tickets`, `POST /api/ticket-paid`
- Existing admin routes under `/api/admin/*`

## Current verification and known blockers

- The Function deployment itself completed successfully as deployment `60`.
- The post-deploy smoke test currently receives HTTP `402` from the Neon Function invocation host before it can verify CORS or `/api/session`. Function logs returned no records, so the exact exhausted allowance or platform restriction is not visible from the Free-plan diagnostics available here. Do not mark the native sign-in flow production-verified until the endpoint returns normally.
- Neon Free includes monthly Function capacity allowances. Check the project's usage/limits in the Neon Console before changing billing. No plan or billing changes are made automatically by this repository.
- The Login Widget domain registration in @BotFather still needs to be confirmed manually.
- The radio playback URL is intentionally not configured until an actual radio stream host is provisioned. Do not put a placeholder URL into `STREAM_URL`.

## Safety notes

- The API must continue to validate `Origin` for cookie-based authentication and state-changing browser routes.
- Never put `TELEGRAM_BOT_TOKEN`, `SESSION_SECRET`, or a database connection string in the Android app or browser JavaScript.
- A verified Telegram identity and the database `is_admin` field are the source of admin authorization. Hiding UI elements alone is not authorization.
- A payment submission is not proof of payment. Only admin approval grants access.
