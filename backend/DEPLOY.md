# Nettle Group API deployment

This adds a server-side API without replacing or redesigning the existing website.

## Required secrets
- `DATABASE_URL`: Neon connection string for `nettle_main` (prefer pooled connection string).
- `TELEGRAM_BOT_TOKEN`: token for `@Verify_NettleBOT`; enter only in deployment secrets.
- `INITIAL_ADMIN_TELEGRAM_ID`: `6393320839`.
- `SESSION_SECRET`: random secret of at least 32 characters (generate locally with `openssl rand -base64 48`).

Never commit real credentials, paste the bot token into chat, or put secrets in browser JavaScript.

## Deployment
1. Import the existing `Merekwi/nettlegroup` repository into Vercel; keep the repository and its root intact.
2. Set the project root to the repository root and add the four environment variables above as server-side secrets.
3. Deploy, then check `/api/session`; without a cookie it should return `authenticated: false`.
4. In BotFather, set the Telegram Login Widget domain to the exact website hostname. The widget's signed callback data must be POSTed to `/api/auth/telegram`.
5. If the site and API are on different origins, configure the API origin and credentialed CORS/cookies deliberately before use. This starter rejects cross-origin state-changing requests.

## API endpoints
- `POST /api/auth/telegram`: verifies Telegram Login Widget HMAC and rejects data older than 10 minutes; issues a signed HttpOnly/Secure/SameSite cookie.
- `POST /api/auth/logout`, `GET /api/session`.
- `GET /api/services`, `GET /api/payment-methods`.
- `GET/POST /api/tickets`, `POST /api/tickets/:id/paid`.
- `POST /api/admin/tickets/:id/decision`: admin-only; reject requires a comment; approval creates a service grant in the same transaction.
- `POST/PATCH /api/admin/services[/id]`.
- `POST/PATCH /api/admin/payment-methods[/id]`.
- `GET/POST /api/admin/grants`.

## Status and limits
This is the backend API, not yet a finished visual account/admin interface. The existing website is untouched. A payment “paid” submission is not proof of payment: only admin approval grants access. No payment provider webhook is configured. Test with a dummy service/ticket before accepting real payments.
