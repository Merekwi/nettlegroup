# Nettle Group API deployment

The current public website remains on GitHub Pages at `https://www.nettlegroup.space/`. Deploy only the API to Vercel on the same parent domain (`api.nettlegroup.space`) so the existing website and design are not replaced.

## Server-side environment variables
- `DATABASE_URL`: Neon connection string for `nettle_main` (prefer pooled connection string).
- `TELEGRAM_BOT_TOKEN`: token for `@Verify_NettleBOT`; enter only in Vercel Environment Variables.
- `INITIAL_ADMIN_TELEGRAM_ID`: `6393320839`.
- `SESSION_SECRET`: random secret of at least 32 characters (generate locally with `openssl rand -base64 48`).
- `SITE_ORIGIN`: exactly `https://www.nettlegroup.space`.
- `COOKIE_DOMAIN`: `.nettlegroup.space`.

Never commit real credentials, paste the bot token into chat, or put secrets in browser JavaScript.

## Deployment steps
1. Connect the existing `Merekwi/nettlegroup` repository to Vercel. Do not create a new GitHub repository or alter the existing website project.
2. Set the project root to the repository root and add all six variables above as server-side Environment Variables.
3. Deploy the API and add the custom domain `api.nettlegroup.space` to the Vercel project.
4. In the DNS provider for `nettlegroup.space`, add the CNAME record requested by Vercel for `api.nettlegroup.space`. Do not change the existing `www.nettlegroup.space` record; that keeps the current website on its existing host.
5. Check `https://api.nettlegroup.space/api/session`; without a session it should return JSON with `authenticated: false`.
6. In BotFather, configure the Telegram Login Widget domain as `www.nettlegroup.space`. The widget's signed callback data is POSTed to the API subdomain and verified server-side.
7. Sign in with the Telegram account whose numeric ID is `6393320839`. The first verified login bootstraps that account as admin.

## API endpoints
- `POST /api/auth/telegram`: validates Telegram Login Widget HMAC and rejects data older than 10 minutes; issues a signed HttpOnly/Secure cookie scoped to `.nettlegroup.space`.
- `POST /api/auth/logout`, `GET /api/session`.
- `GET /api/services`, `GET /api/payment-methods`.
- `GET/POST /api/tickets`, `POST /api/tickets/:id/paid`.
- `POST /api/admin/tickets/:id/decision`: admin-only; rejection requires a comment; approval creates a service grant in the same transaction.
- `POST/PATCH /api/admin/services[/id]`.
- `POST/PATCH /api/admin/payment-methods[/id]`.
- `GET/POST /api/admin/grants`.

## Notes
- The existing website is not redesigned or replaced. The account page is `account.html`, linked from the main navigation.
- A payment “paid” submission is not proof of payment: only admin approval grants access. No payment provider webhook is configured.
- The API allows credentialed requests only from the exact `SITE_ORIGIN`. Test with a dummy service/ticket before accepting real payments.
- The API code is committed but is not deployed until Vercel is connected and the environment variables and API DNS record are configured.
