const { AdminAuditLog, AuthEvent, ApiIssue, ApiTraffic } = require('./models');

// One middleware, mounted once at the top of /api (routes/index.js).
// It never changes a request or a response — it only watches them finish:
//
//   • admin changes (POST/PUT/PATCH/DELETE by an admin)  → AdminAuditLog
//   • sign-ups, logins and failed logins                 → AuthEvent
//   • 5xx errors and "Route not found" 404s              → ApiIssue
//   • every request, counted per hour                    → ApiTraffic
//
// Writes happen after the response is sent and errors are swallowed, so
// tracking can never slow down or break the API.

const SECRET_PART = /(password|passcode|token|secret|otp|cvv|cardnumber|accountnumber|ifsc|aadhaar|apikey|privatekey)/i;
const SECRET_EXACT = /^(pin|pan|code|card|account)$/i;
const isSecret = (key) => SECRET_PART.test(key) || SECRET_EXACT.test(key);
const MAX_BODY_CHARS = 4000;

/** /api/admin/users/652f…/suspend?x=1 → /api/admin/users/:id/suspend */
function normalisePath(url) {
  return String(url || '')
    .split('?')[0]
    .split('/')
    .map((seg) => (/^[a-f0-9]{24}$/i.test(seg) ? ':id' : /^\d+$/.test(seg) ? ':n' : seg))
    .join('/')
    .slice(0, 300);
}

/** Request body without secrets, short enough to store. */
function safeBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (isSecret(k)) out[k] = '••••';
    else if (v && typeof v === 'object') out[k] = JSON.parse(JSON.stringify(v, (key, val) => (key && isSecret(key) ? '••••' : val)));
    else out[k] = typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…` : v;
  }
  const json = JSON.stringify(out);
  if (json.length > MAX_BODY_CHARS) return { note: 'Large request body — not stored', keys: Object.keys(out).slice(0, 30) };
  return Object.keys(out).length ? out : null;
}

/** Which app sent it: the Flutter app sends no Origin header; browsers do. */
function clientOf(req) {
  const origin = String(req.headers.origin || req.headers.referer || '');
  const ua = String(req.headers['user-agent'] || '');
  if (/admin/i.test(origin)) return 'admin';
  if (origin) return 'web';
  if (/dart|okhttp|flutter/i.test(ua)) return 'app';
  return 'unknown';
}

/** "/api/admin/users/:id/suspend" → { area: 'users', targetType: 'users', targetId } */
function targetOf(rawPath, normPath) {
  const raw = rawPath.split('?')[0].split('/').filter(Boolean);
  const norm = normPath.split('/').filter(Boolean);
  // drop "api" and the "admin" prefix (works for /api/admin/x and /api/x/admin/y)
  const parts = norm.filter((p, i) => !(i === 0 && p === 'api') && p !== 'admin');
  const area = parts[0] || '';
  const idIndex = norm.indexOf(':id');
  return {
    area,
    targetType: idIndex > 0 ? norm[idIndex - 1] : area,
    targetId: idIndex >= 0 ? raw[idIndex] || '' : '',
  };
}

// ---------- hourly traffic, flushed in batches ----------

let bucket = new Map(); // hourISO -> counters
function countRequest(status, ms) {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  const key = d.toISOString();
  const c = bucket.get(key) || { total: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, totalMs: 0 };
  c.total += 1;
  c.totalMs += Math.round(ms);
  if (status >= 500) c.s5xx += 1;
  else if (status >= 400) c.s4xx += 1;
  else if (status >= 300) c.s3xx += 1;
  else c.s2xx += 1;
  bucket.set(key, c);
}

async function flushTraffic() {
  if (!bucket.size) return;
  const pending = bucket;
  bucket = new Map();
  await Promise.all(
    [...pending.entries()].map(([hour, c]) => ApiTraffic.updateOne({ hour: new Date(hour) }, { $inc: c }, { upsert: true }).catch(() => {}))
  );
}
const flushTimer = setInterval(() => flushTraffic().catch(() => {}), 60 * 1000);
if (flushTimer.unref) flushTimer.unref();

// ---------- the middleware ----------

const AUTH_ACTIONS = /^\/api\/auth\/([a-z0-9-/]+)$/i;
const SKIP_AUTH = /^(refresh|logout|me|forgot-password|upgrade-role|complete-onboarding)$/;

function tracker(req, res, next) {
  const started = process.hrtime.bigint();
  let body;
  const json = res.json.bind(res);
  res.json = (payload) => {
    body = payload;
    return json(payload);
  };

  res.on('finish', () => {
    try {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const status = res.statusCode;
      countRequest(status, ms);

      const rawPath = String(req.originalUrl || req.url || '');
      const path = normalisePath(rawPath);
      const method = req.method;
      const message = body && typeof body.message === 'string' ? body.message.slice(0, 300) : '';
      const user = req.user;
      const ip = String(req.ip || '').slice(0, 64);
      const userAgent = String(req.headers['user-agent'] || '').slice(0, 200);

      // 1) Admin changes
      if (user && user.role === 'admin' && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !path.startsWith('/api/auth/')) {
        const t = targetOf(rawPath, path);
        AdminAuditLog.create({
          actor: user._id,
          actorName: user.name || '',
          actorEmail: user.email || '',
          method,
          path,
          rawPath: rawPath.split('?')[0].slice(0, 300),
          ...t,
          status,
          success: status < 400,
          message,
          changes: safeBody(req.body),
          ip,
          userAgent,
          durationMs: Math.round(ms),
        }).catch(() => {});
      }

      // 2) Sign-ups and logins
      const auth = method === 'POST' && rawPath.split('?')[0].match(AUTH_ACTIONS);
      if (auth && !SKIP_AUTH.test(auth[1])) {
        const data = body && body.data;
        const who = data && (data.user || (data.accessToken && data));
        if (status < 400 && who && who._id) {
          AuthEvent.create({
            user: who._id,
            name: who.name || '',
            email: who.email || '',
            role: who.role || '',
            action: auth[1],
            success: true,
            client: clientOf(req),
            ip,
            userAgent,
          }).catch(() => {});
        } else if (status === 400 || status === 401 || status === 403) {
          AuthEvent.create({
            email: String((req.body && (req.body.email || req.body.phone)) || '').slice(0, 120),
            action: auth[1],
            success: false,
            reason: message,
            client: clientOf(req),
            ip,
            userAgent,
          }).catch(() => {});
        }
      }

      // 3) Server errors and missing routes
      const missingRoute = status === 404 && message.startsWith('Route not found');
      if (status >= 500 || missingRoute) {
        const key = `${method} ${path} ${status}`;
        ApiIssue.updateOne(
          { key },
          {
            $inc: { count: 1 },
            $set: {
              lastMessage: message,
              lastSeenAt: new Date(),
              lastUser: user ? user._id : null,
              lastRole: user ? user.role : 'guest',
              lastClient: clientOf(req),
              resolvedAt: null,
            },
            $setOnInsert: { method, path, status, kind: missingRoute ? 'missing_route' : 'server_error', firstSeenAt: new Date() },
          },
          { upsert: true }
        ).catch(() => {});
      }
    } catch {
      // tracking must never affect the API
    }
  });

  next();
}

module.exports = { tracker, flushTraffic, normalisePath, safeBody };