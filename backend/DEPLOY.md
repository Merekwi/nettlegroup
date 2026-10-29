# Nettle Group API — Neon Functions

The existing website remains on GitHub Pages at `https://www.nettlegroup.space/`. The API is deployed as a Neon Function in the existing `nettlegroup` project and uses the existing `nettle_main` database. No Vercel project is required.

## Deployment status

- Neon Function slug: `nettleapi`
- Native function URL: `https://br-little-union-b9iipjfz-nettleapi.compute.c-7.eu-central-1.aws.neon.tech/`
- Custom API domain requested: `api.nettlegroup.space`
- Custom domain currently awaits DNS verification.
- The function has a deployed Node.js 24 runtime and uses Neon-injected `DATABASE_URL`.

## One DNS change still required

At the DNS provider managing `nettlegroup.space`, create this record:

| Type | Name / Host | Target / Value |
|---|---|---|
| CNAME | `api` | `fn-custom-domains.eu-central-1.aws.neon.tech` |

Use the DNS provider's normal TTL/default. Do not change the existing `www` record or the root-domain records. After DNS propagates, the Neon custom domain should verify automatically.

## Required bot setup

The API validates the Telegram Login Widget signature server-side using the token for `@Verify_NettleBOT`.

1. In @BotFather, configure the domain `www.nettlegroup.space` for the Telegram Login Widget.
2. In the Neon dashboard, open the `nettlegroup` project, the `main` branch, and the `nettleapi` Function deployment environment.
3. Add `TELEGRAM_BOT_TOKEN` with the bot token from @BotFather. Do not commit it to GitHub or put it in website JavaScript.
4. Keep these already-configured variables:
   - `SITE_ORIGIN=https://www.nettlegroup.space`
   - `COOKIE_DOMAIN=.nettlegroup.space`
   - `INITIAL_ADMIN_TELEGRAM_ID=6393320839`
   - `SESSION_SECRET` (server-only)
5. Redeploy the function after changing environment variables.

The first successful login for Telegram ID `6393320839` is marked as the initial admin. The server still checks `is_admin` on every admin request.

## Smoke tests after DNS and bot setup

- Open `https://api.nettlegroup.space/api/session`; without a session it should return JSON with `authenticated: false`.
- Open `https://www.nettlegroup.space/account.html` and sign in through Telegram.
- Create a dummy service and payment method, then a test ticket.
- Confirm that pressing “Я оплатил” only submits the ticket; it must not grant access until an admin approves it.
- Approve and reject a test ticket; rejection requires a comment.

## API routes

- `POST /api/auth/telegram`: verifies Telegram Login Widget HMAC and rejects stale data; issues a signed HttpOnly/Secure cookie.
- `POST /api/auth/logout`, `GET /api/session`.
- `GET /api/services`, `GET /api/payment-methods`.
- `GET/POST /api/tickets`, `POST /api/ticket-paid`.
- `POST /api/admin/ticket-decision`: admin-only; rejection requires a comment; approval creates a service grant transactionally.
- `POST /api/admin/services`, `POST /api/admin/service-update`.
- `POST /api/admin/payment-methods`, `POST /api/admin/payment-method-update`.
- `GET/POST /api/admin/grants`.

## Important

- API code is in `neon-function/` and `backend/api-handler.js`; the deployed function is currently versioned in Neon.
- This uses Telegram Login Widget, not a bot-issued one-time code flow.
- A payment “paid” submission is not proof of payment. Only admin approval grants access; no payment-provider webhook is configured.
- Do not treat the system as production-ready until the domain, bot token, Telegram widget, and payment workflow have been tested end-to-end.
