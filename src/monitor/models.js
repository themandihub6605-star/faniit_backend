const mongoose = require('mongoose');

// Admin panel tracking data (see monitor/README.md).
//
//   AdminAuditLog   every change an admin makes (who, what, when, result)
//   AuthEvent       logins / sign-ups / failed logins on app + website
//   ApiIssue        server errors and missing routes, grouped per endpoint
//   ApiTraffic      request counts per hour (for error rate / response time)
//
// All four only hold data from the day this was deployed — nothing older.
// Old rows clean themselves up (TTL indexes).

const DAY = 24 * 60 * 60;

const auditSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    actorName: { type: String, default: '' },
    actorEmail: { type: String, default: '' },
    method: { type: String, required: true },
    path: { type: String, required: true }, // normalised: /api/admin/users/:id/suspend
    rawPath: { type: String, default: '' },
    area: { type: String, default: '', index: true }, // users, withdrawals, store, …
    targetType: { type: String, default: '' },
    targetId: { type: String, default: '', index: true },
    status: { type: Number, required: true },
    success: { type: Boolean, required: true },
    message: { type: String, default: '' }, // API response message, e.g. "User suspended"
    changes: { type: mongoose.Schema.Types.Mixed, default: null }, // request body (secrets removed)
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    durationMs: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: 365 * DAY },
  },
  { versionKey: false }
);
auditSchema.index({ createdAt: -1 });

const authEventSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    role: { type: String, default: '' },
    action: { type: String, required: true }, // login, google, register, verify-otp, …
    success: { type: Boolean, required: true, index: true },
    reason: { type: String, default: '' },
    client: { type: String, default: '' }, // app | web | admin | unknown
    ip: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now, expires: 180 * DAY },
  },
  { versionKey: false }
);
authEventSchema.index({ createdAt: -1 });

const apiIssueSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // "GET /api/x/:id 500"
    method: { type: String, required: true },
    path: { type: String, required: true },
    status: { type: Number, required: true, index: true },
    kind: { type: String, enum: ['server_error', 'missing_route'], required: true, index: true },
    count: { type: Number, default: 0 },
    lastMessage: { type: String, default: '' },
    lastUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lastRole: { type: String, default: '' },
    lastClient: { type: String, default: '' },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now, index: true },
    resolvedAt: { type: Date, default: null },
  },
  { versionKey: false }
);

const apiTrafficSchema = new mongoose.Schema(
  {
    hour: { type: Date, required: true, unique: true }, // start of the hour (UTC)
    total: { type: Number, default: 0 },
    s2xx: { type: Number, default: 0 },
    s3xx: { type: Number, default: 0 },
    s4xx: { type: Number, default: 0 },
    s5xx: { type: Number, default: 0 },
    totalMs: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, expires: 120 * DAY },
  },
  { versionKey: false }
);

const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

module.exports = {
  AdminAuditLog: model('AdminAuditLog', auditSchema),
  AuthEvent: model('AuthEvent', authEventSchema),
  ApiIssue: model('ApiIssue', apiIssueSchema),
  ApiTraffic: model('ApiTraffic', apiTrafficSchema),
};