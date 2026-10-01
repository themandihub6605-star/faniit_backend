# Fanitt Store — backend

Everything for Fanitt Store lives in this folder. It plugs into the main
app at `/api/store` (see `src/routes/index.js`) and reuses the existing
User, CreatorProfile, Transaction, Notification, wallet and Razorpay code.

## Folder layout

```
FanittStore/
  index.js            router entry (mounted at /api/store)
  constants.js        every status, limit and file type in one place
  models/             Store, StoreSettings, DigitalProduct, StoreOrder, StoreCounter
  services/           business logic (no req/res here)
    store.service       store lookup + setup-step state machine
    settings.service    admin settings (cached 30s)
    storage.service     private R2 files: signed upload/download links
    order.service       checkout → verify → paid (exactly once) → refund
    earnings.service    splits a sale and credits the ONE existing wallet
    invoice.service     invoice numbers + printable invoice
    notify.service      notifications that can never break a request
    livekit.service     LiveKit tokens, rooms and webhook verification
    liveAccess.service  who may watch a live (public/invite/community/selected + tickets)
    live.service        live lifecycle: start, end, cancel (refunds tickets)
    call.service        1-to-1 calls: request, accept, join, per-minute billing, timeouts
    jobs.service        background timer (call timeouts, stale lives) — started in server.js
    realtime.service    Socket.IO pushes to a user's app (incoming call, accepted, ended)
    fanbox.service      FanBox tips (3% fee), also used by the old /api/gifts endpoints
    analytics.service   view/click tracking + creator and platform reports
    linkPreview.service reads a product page to pre-fill affiliate products (blocks private addresses)
  controllers/        thin HTTP handlers
  routes/             store.routes.js (users) · admin.routes.js (admin)
  validators/         zod schemas for every request body
  utils/              logger, money, text helpers, serializers, KYC upload
```

## Money rules

- Amounts are always **paise** (integers).
- A sale of `amount`: store fee (`StoreSettings.storeFeePercent`, default 9%)
  goes to Fanitt, then the existing agency/referral split runs, and the rest
  is added to the seller's `walletBalance` (the same wallet as everything else).
- The credited part is also added to `User.walletFeeExempt`, so the normal
  withdrawal fee isn't charged a second time on store money.
- Refunds (admin) go back through Razorpay, take the credit back out of the
  seller's wallet and remove the buyer's access.

- Any paid item can be paid with Razorpay **or** from the Fanitt wallet
  (`payWith: "wallet"`), so money returned to the wallet can be spent again.

## Live streams (LiveKit)

- Creator: `POST /me/lives` (now or `scheduledAt`) → `POST /me/lives/:id/start`
  returns a host token → `POST /me/lives/:id/end`. `cancel` refunds every ticket.
- Audience: public, or private by invite link (`inviteCode`), community
  (members of a community the creator runs) or selected users. `price > 0`
  also needs a ticket (`POST /lives/:id/checkout`).
- Viewers: `POST /lives/:id/join` → `{ connection: { url, token } }`. Viewers
  can watch, chat and react (LiveKit data messages) but not publish.
- Viewer counts come from the LiveKit webhook.

## Calls (per minute, prepaid)

- Creator sets `PATCH /me/calls/settings` (rates in paise/minute, 0 = free)
  and goes `POST /me/calls/online`.
- Buyer: `POST /stores/:storeId/calls { type, minutes }` → pays (Razorpay or
  wallet) → creator gets `store_call_request` (socket + push) → accepts within
  2 minutes → both `POST /calls/:id/join` → billing starts when BOTH joined.
- Billed per started minute (connections under 10 s are free), capped at the
  prepaid minutes; the call auto-ends when time runs out. Unused minutes go
  back to the caller's wallet. Declined / missed / cancelled = full refund.

## FanBox

`POST /fanbox { creatorId | storeId, amount, message?, context?, payWith? }`
(₹10–₹1,00,000). Works for any creator, with or without a store. The FanBox
fee (`fanboxFeePercent`, default 3%) is taken when it's credited, and a
`Gift` record is still created so older screens keep listing it. The old
`/api/gifts/create-order` and `/api/gifts/verify` now run through this flow,
so the amount can't be changed by the app and a payment is credited once.

## Affiliate Store

- Creator adds products with their affiliate link (`/me/affiliate/products`),
  optionally auto-filled from the product page (`/me/affiliate/preview`),
  and groups them into collections.
- Buyers open `GET /api/store/go/:id` — the click is counted and they are
  redirected to the merchant. The raw affiliate link is never in public API
  responses.
- Merchants pay creators directly, so affiliate earnings are a log the
  creator keeps (`/me/affiliate/earnings`, pending → confirmed → reversed).
  They show in analytics but never touch the Fanitt wallet.

## Analytics

`GET /me/analytics?days=7|30|90|365` — revenue by source (products, live
tickets, calls, FanBox), fees and net, daily series, store views, unique
visitors, conversion, top items, lives, calls, FanBox and affiliate.
`GET /me/customers` — buyers with orders and spend. Admin:
`GET /admin/analytics?days=` (platform totals, Fanitt's fee revenue, top stores).
Days are India calendar days.

## Virtual Meet

The existing Live Sessions (Zoom) feature, shown in the store: upcoming
sessions appear on the store page and in `GET /me/meets`. Booking and
joining still use `/api/sessions` and `/api/bookings`.

## Setup flow (creator)

`POST /me` (profile) → `PUT /me/payout` → `POST /me/kyc` → `POST /me/terms`
→ status `pending_review` → admin approves KYC → `active` (can sell).

## Endpoints

Public: `GET /config` · `GET /stores` · `GET /stores/:slug` · `GET /products/:id`

Creator (`role=creator`): `GET|POST|PATCH /me` · `POST /me/logo|banner` ·
`PUT /me/payout` · `POST /me/kyc` (multipart panDocument + idDocument) ·
`POST /me/terms` · `GET /me/summary` · `GET /me/sales` ·
`GET|POST /me/products` · `GET|PATCH|DELETE /me/products/:id` ·
`POST /me/products/:id/cover` · `POST /me/products/:id/files/upload-url` ·
`POST /me/products/:id/files` · `DELETE /me/products/:id/files/:fileId` ·
`GET /me/products/:id/files/:fileId/preview` · `POST /me/products/:id/publish|unpublish`

Buyer (any logged-in user): `POST /products/:id/checkout` ·
`POST /orders/:id/verify` · `GET /orders/mine` · `GET /orders/:id/invoice(.html)` ·
`GET /library` · `GET /library/:productId/files/:fileId/download`

Admin (`/admin/...`, role=admin): `overview` · `analytics` · `affiliate(/:id/remove|restore)` · `fanbox` · `lives` · `calls` · `stores` · `stores/:id` ·
`stores/:id/kyc` · `stores/:id/status` · `products` · `products/:id/remove|restore` ·
`orders` · `orders/:id/refund` · `settings` · `tool-cards/:key(/image)` · `banner(/image)`

## Uploading product files (app)

1. `POST /me/products/:id/files/upload-url` with `{ fileName, mimeType, size }`
2. `PUT` the file to `uploadUrl` with the returned `Content-Type` header
3. `POST /me/products/:id/files` with `{ key, fileName }` — the server checks
   the file really exists and records its real size/type.

## Environment

LiveKit (required for live + calls), from LiveKit Cloud → Settings → Keys:
`LIVEKIT_URL=wss://<project>.livekit.cloud`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`.
In LiveKit Cloud → Settings → Webhooks add
`https://api.fanitt.com/api/store/livekit/webhook` (viewer counts, call room closing).

Uses the existing R2 settings. Optional (recommended):
`R2_PRIVATE_BUCKET_NAME` — a bucket with public access OFF for product files
and KYC documents. Without it, the main bucket is used (files still only
reachable through signed links with random names).

## Debugging

Every log line starts with `[FanittStore]` and an event name:

```
pm2 logs fanitt-api --lines 200 | grep FanittStore
```

Useful events: `order.created`, `order.paid`, `order.wallet_debited`, `earnings.credited`,
`live.started`, `live.ended`, `live.cancelled`, `call.requested`, `call.accepted`,
`call.connected`, `call.closed`, `call.settled`, `earnings.wallet_refund`, `webhook.rejected`,
`earnings.credit_failed` (includes every id needed to fix it by hand),
`order.bad_signature`, `order.not_paid_on_razorpay`, `order.refunded`,
`store.submitted_for_review`, `admin.kyc_reviewed`.

Errors come back in the normal Fanitt format with an `errorCode` where the
app should react: `STORE_NOT_FOUND`, `STORE_NOT_ACTIVE`, `CREATOR_ONLY`,
`STORE_EXISTS`, `TERMS_OUTDATED`, `PRODUCT_INCOMPLETE`, `PRODUCT_REMOVED`,
`PRODUCT_HAS_SALES`, `ALREADY_OWNED`, `NOT_PURCHASED`, `INSUFFICIENT_WALLET`,
`ALREADY_LIVE`, `LIVE_NOT_RUNNING`, `TICKET_REQUIRED`, `LIVE_PRIVATE`,
`CREATOR_OFFLINE`, `CREATOR_BUSY`, `CALL_ALREADY_OPEN`.

Socket events sent to the app: `store_call_request`, `store_call_accepted`, `store_call_ended`.
