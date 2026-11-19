// File: src/models/InstagramAccount.model.js
const mongoose = require('mongoose');

// An Instagram professional account a Fanitt user connected with
// Instagram Login (fanitt.com/connect/instagram), plus its Auto DM rules.
// One Instagram account per Fanitt user. The token is never sent to a client.

const ruleSchema = new mongoose.Schema(
  {
    // 'any' = every post/reel, otherwise one Instagram media id.
    mediaId: { type: String, default: 'any' },
    mediaCaption: { type: String, default: '' },
    mediaThumb: { type: String, default: '' },
    mediaPermalink: { type: String, default: '' },
    keyword: { type: String, required: true, trim: true },
    dmText: { type: String, required: true },
    replyText: { type: String, default: '' }, // optional public reply under the comment
    active: { type: Boolean, default: true },
    sentCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const logSchema = new mongoose.Schema(
  {
    commentId: { type: String, default: '' },
    fromUsername: { type: String, default: '' },
    commentText: { type: String, default: '' },
    mediaId: { type: String, default: '' },
    keyword: { type: String, default: '' },
    dmStatus: { type: String, default: '' }, // sent | failed
    replyStatus: { type: String, default: '' }, // sent | failed | ''
    error: { type: String, default: '' },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const instagramAccountSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    igUserId: { type: String, required: true, index: true }, // the id webhooks use
    username: { type: String, default: '' },
    name: { type: String, default: '' },
    profilePictureUrl: { type: String, default: '' },
    followersCount: { type: Number, default: 0 },
    followsCount: { type: Number, default: 0 },
    mediaCount: { type: Number, default: 0 },
    accessToken: { type: String, required: true, select: false },
    tokenExpiresAt: { type: Date },
    status: { type: String, enum: ['connected', 'disconnected'], default: 'connected' },
    lastError: { type: String, default: '' },
    rules: { type: [ruleSchema], default: [] },
    log: { type: [logSchema], default: [] },
    handledCommentIds: { type: [String], default: [], select: false }, // one DM per comment
  },
  { timestamps: true },
);

/** Keep only the newest 50 log lines. */
instagramAccountSchema.methods.addLog = function addLog(line) {
  this.log.push(line);
  if (this.log.length > 50) this.log = this.log.slice(-50);
};

/** What the website may see (no token). */
instagramAccountSchema.methods.toPublic = function toPublic() {
  return {
    igUserId: this.igUserId,
    username: this.username,
    name: this.name,
    profilePictureUrl: this.profilePictureUrl,
    followersCount: this.followersCount,
    followsCount: this.followsCount,
    mediaCount: this.mediaCount,
    status: this.status,
    lastError: this.lastError,
    connectedAt: this.createdAt,
    rules: this.rules.map((r) => ({
      id: String(r._id),
      mediaId: r.mediaId,
      mediaCaption: r.mediaCaption,
      mediaThumb: r.mediaThumb,
      mediaPermalink: r.mediaPermalink,
      keyword: r.keyword,
      dmText: r.dmText,
      replyText: r.replyText,
      active: r.active,
      sentCount: r.sentCount,
    })),
    log: [...this.log].reverse(),
  };
};

module.exports = mongoose.model('InstagramAccount', instagramAccountSchema);