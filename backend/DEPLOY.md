# Nettle Group API — Neon Functions

The existing website remains on GitHub Pages at `https://www.nettlegroup.space/`. The API is deployed inside the existing Neon project `nettlegroup` and uses `nettle_main`. **No Vercel project or extra hosting provider is needed.**

## Current deployment

- Neon project: `dry-shape-51006688`
- Main branch: `br-little-union-b9iipjfz`
- Function slug: `nettleapi`
- Active deployment: `4` (Node.js 24; deployment status `completed`)
- Native function URL: https://br-little-union-b9iipjfz-nettleapi.compute.c-7.eu-central-1.aws.neon.tech/
- Custom domain binding: `api.nettlegroup.space` (registered, DNS currently points elsewhere / is not configured)
- `DATABASE_URL` is injected by Neon at runtime.
- Server environment already configured: `SITE_ORIGIN`, `COOKIE_DOMAIN`, `INITIAL_ADMIN_TELEGRAM_ID`, `SESSION_SECRET`.
- **Still missing:** `TELEGRAM_BOT_TOKEN` must be added as a secret in the Neon Function environment; the bot token has not been put in GitHub or this document.

## One DNS change required

At the DNS provider managing `nettlegroup.space`, create/update this record:

| Type | Name / Host | Target / Value |
|---|---|---|
| CNAME | `api` | `fn-custom-domains.eu-central-1.aws.neon.tech` |

Do not change the existing `www` record or root-domain records. Neon currently reports `cname-not-pointing-at-edge`; the API custom domain will not work until the CNAME points to the target above and DNS propagates.

## Finish Telegram login

1. Open @BotFather and configure the Telegram Login Widget domain as `www.nettlegroup.space`.
2. In the Neon dashboard, open project `nettlegroup` → main branch → Functions → `nettleapi` → environment/secrets.
3. Add `TELEGRAM_BOT_TOKEN` using the token from @BotFather. **Do not paste it into chat, commit it to GitHub, or place it in browser JavaScript.**
4. Redeploy the function after adding the variable. Keep the already-configured variables listed above.
5. The first verified login for Telegram ID `6393320839` receives initial admin status. Admin privileges are checked against `user_profiles.is_admin` on each admin request.

## Smoke tests

After the CNAME and bot token are configured:

- Open `https://api.nettlegroup.space/api/session`; without a session it should return `authenticated: false`.
- Open `https://www.nettlegroup.space/account.html` and sign in through Telegram.
- Create a dummy service, payment method and ticket.
- Pressing “Я оплатил” must only submit a ticket; it must not grant access.
- Test approval and rejection (rejection requires a comment).

## API routes

- `POST /api/auth/telegram`, `POST /api/auth/logout`, `GET /api/session`
- `GET /api/services`, `GET /api/payment-methods`
- `GET/POST /api/tickets`, `POST /api/ticket-paid`
- `POST /api/admin/ticket-decision` — admin-only; rejection requires a comment; approval creates a service grant transactionally
- `POST /api/admin/services`, `POST /api/admin/service-update`
- `POST /api/admin/payment-methods`, `POST /api/admin/payment-method-update`
- `GET/POST /api/admin/grants`

## Important

- Function source of truth: `neon-function/index.mjs` and `neon-function/api-handler.cjs`; config: `neon.ts`.
- This uses Telegram Login Widget, not a bot-issued one-time-code flow.
- A “paid” submission is not proof of payment. Only admin approval grants access; no payment-provider webhook is configured.
- The function deployment is active, but the login/payment flow has **not yet been end-to-end verified** because the custom DNS record and bot token are still missing.
- Durable rate limiting and additional production hardening remain outstanding.
