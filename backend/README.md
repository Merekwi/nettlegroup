# Nettle Group backend

## Current infrastructure

- Frontend: existing static site in this repository; keep the existing design and content.
- Database: Neon PostgreSQL project `nettlegroup`, database `nettle_main`.
- Baseline SQL: `database/schema.sql`.
- The database currently contains seven tables: `user_profiles`, `service_catalog`, `payment_methods`, `payment_tickets`, `service_grants`, `site_settings`, and `audit_logs`.

## Security rules

1. Never place the Neon connection string, Telegram bot token, or any server secret in frontend JavaScript, HTML, CSS, or a public repository.
2. Never accept a Telegram user ID or admin flag from the browser as proof of identity. Verify Telegram Login Widget data or Mini App `initData` server-side with the bot token, validate the authentication timestamp, and reject stale or invalid signatures.
3. The first administrator must be bootstrapped from a trusted server-side configuration (e.g. `INITIAL_ADMIN_TELEGRAM_ID`), not by letting a user promote themselves.
4. Every admin endpoint must check the verified Telegram identity against `user_profiles.is_admin` on the server.
5. Payment submissions are claims, not proof of payment. Only an administrator can approve or reject a ticket until a trusted payment-provider webhook is implemented.
6. Generate order codes on the server using cryptographically secure randomness; enforce uniqueness in PostgreSQL.
7. Use parameterized SQL and validate request bodies. Durable rate limiting is still a pre-production task and is not implemented in this starter.
8. Do not enable anonymous write access to these tables through a public Data API.

## Intended API contract

- `GET /api/session`: return the verified current user's public profile and admin status.
- `GET /api/services`: list active services and public prices.
- `GET /api/payment-methods`: list active payment instructions without exposing internal metadata.
- `GET /api/tickets`: list the authenticated user's own tickets; admin can filter all tickets.
- `POST /api/tickets`: create an order ticket for an active service and payment method.
- `POST /api/ticket-paid` with `ticketId`: mark a ticket as payment-submitted; does not approve it.
- `POST /api/admin/ticket-decision` with `ticketId`: admin-only approve/reject with a required reason for rejection.
- `POST /api/admin/services` and `POST /api/admin/service-update`: admin-only service management.
- `POST /api/admin/payment-methods` and `POST /api/admin/payment-method-update`: admin-only payment method management.
- `POST /api/admin/grants`: admin-only manual access grant/revoke with audit log.

## Deployment status

The schema is live and verified. The API is deployed as Neon Function `nettleapi` (active deployment 4, Node.js 24) in the existing project; no Vercel project is used. Source of truth: `neon-function/index.mjs` and `neon-function/api-handler.cjs`. The frontend account page is `account.html`. The custom domain `api.nettlegroup.space` is registered in Neon but DNS is not yet pointing to Neon's CNAME target, and `TELEGRAM_BOT_TOKEN` still needs to be added in the Neon Function environment. Until those two steps are complete, end-to-end login and payment flows are not verified. Durable rate limiting and additional production hardening remain outstanding. Neon Auth's built-in social sign-in does not provide Telegram login, so do not substitute Google/GitHub login for the requested Telegram flow.
