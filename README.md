# Fanitt Backend

Node.js + Express + MongoDB backend for the Fanitt platform — creators, brands, fans and agencies collaborating, with Zoom-powered live sessions and Razorpay-protected payments/escrow.

## Stack

- **Express.js** — REST API, MVC-style structure
- **MongoDB + Mongoose** — database
- **JWT** — access + refresh token auth, role-based
- **Razorpay** — session payments, donations, campaign escrow
- **Zoom Server-to-Server OAuth + Meeting SDK** — live sessions, embedded Client View join (same approach as the earlier live-streaming project)
- **Zod** — request validation
- **Multer** — file uploads (swap for S3/Cloudinary in production)

## Folder structure

```
fanitt-backend/
├── src/
│   ├── config/          # db.js, env.js, razorpay.js, zoom.js
│   ├── models/           # Mongoose schemas
│   ├── controllers/      # business logic, one file per module
│   ├── routes/            # route definitions, one file per module + index.js
│   ├── middlewares/      # auth, role check, error handler, upload, validation, rate limiting
│   ├── services/          # payment, escrow, zoom, notification, wallet — reusable business logic
│   ├── validators/       # Zod schemas per module
│   ├── utils/              # apiResponse, apiError, catchAsync, generateToken, slugify, seed
│   ├── constants/       # enums.js — every role/status/type used across the app
│   └── app.js              # Express app setup
├── server.js               # entry point
├── .env.example
└── package.json
```

## Setup

```bash
npm install
cp .env.example .env   # fill in MongoDB URI, JWT secrets, Razorpay + Zoom credentials
npm run seed             # seeds the 10 categories + a default admin user
npm run dev               # starts with nodemon
```

Default admin (change immediately after first login):
- Email: `admin@fanitt.com` (or `ADMIN_EMAIL` from .env)
- Password: `ChangeMe123!` (or `ADMIN_PASSWORD` from .env)

## Auth model

- `role` — the user's currently active role (`fan` | `creator` | `brand` | `agency` | `admin`)
- `roles` — every role the user has ever held (a Fan can upgrade to Creator without losing their Fan history)
- Every protected route uses `protect` (verifies JWT) then optionally `authorize('creator', 'brand', ...)` for role gating.

## API modules (all under `/api`)

| Module | Base path | Notes |
|---|---|---|
| Auth | `/auth` | register, login, refresh, logout, forgot/reset password, role upgrade |
| Users | `/users` | profile, avatar upload |
| Creators | `/creators` | public listing/profile, own dashboard, follow |
| Sessions | `/sessions` | CRUD (creator), Zoom meeting auto-provisioned on create, join-token endpoint |
| Bookings | `/bookings` | book a session, verify Razorpay payment, my bookings |
| Brands | `/brands` | profile, dashboard |
| Campaigns | `/campaigns` | **brand-only posting** (the one thing brands can post), apply, accept, fund escrow, submit work, approve → releases escrow |
| Payments | `/payments` | Razorpay webhook (raw body, server-to-server source of truth), transaction history |
| Donations | `/donations` | live-session donations |
| Reviews | `/reviews` | bidirectional ratings |
| Agency | `/agency` | referral code linking, commission dashboard |
| Notifications | `/notifications` | list, mark read |
| Categories | `/categories` | public read (admin manages via `/admin/categories`) |
| Admin | `/admin` | the single admin panel's backend — see below |

## Admin panel scope (`/api/admin/*`, requires `role: admin`)

- **Users** — list/search, suspend/reinstate
- **Verification** — pending creators/brands, approve/reject
- **Content moderation** — sessions, campaigns, hide reviews
- **Payments/Escrow** — every transaction, disputed escrows, manual release/refund
- **Analytics** — total users/creators/brands/sessions/campaigns, total revenue, platform commission, funds currently in escrow, monthly revenue trend
- **Categories** — create/update/deactivate

## Payment flows

**A) Session booking (Fan → Creator, direct)**
`POST /bookings` → Razorpay order → checkout → `POST /bookings/verify-payment` → commission split (`wallet.service.js`) → creator wallet credited → booking confirmed.

**B) Campaign escrow (Brand → Creator, protected)**
Brand posts requirement → creator applies → brand accepts → `POST /campaigns/:id/fund-escrow` (Razorpay order) → `verify-escrow-payment` marks funds `IN_ESCROW` → creator works → `PATCH /campaigns/:id/submit` → brand `PATCH /campaigns/:id/approve` → `escrow.service.js` splits commission and releases to the creator's wallet. Disputes are resolved by admin via `POST /admin/escrow/:campaignId/release` or `/refund`.

## Live sessions (Zoom)

- `POST /sessions` (creator) auto-creates a Zoom meeting via Server-to-Server OAuth (`zoom.service.js` → `createMeeting`).
- `GET /sessions/:id/join-token` generates a Meeting SDK signature (JWT, HS256) so the frontend can join **inside the Fanitt UI** via Zoom's Client View (`ZoomMtg`) — no redirect to the Zoom app. Role `1` for the host (creator), `0` for attendees (fans).

## Every transaction lives in one place

`Transaction` is the single source of truth the admin panel reads from — every rupee that moves (session payments, donations, escrow deposits, escrow releases, platform commission, agency commission) is one row here, linked back to whatever it was for via `relatedModel`/`relatedId`.
