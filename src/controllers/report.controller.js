// File: src/controllers/report.controller.js
const mongoose = require('mongoose');
const { Report, User, Post, Story, Community, CommunityPost, CommunityComment, CommunityMessage, Message, Conversation } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

// Reports (user-generated content safety).
//
//   POST  /reports                 { targetType, targetId, reason, details? }
//   GET   /reports/mine            what I reported (the app hides these for me)
//   GET   /reports/admin           ?status=pending|removed|suspended|dismissed|all &type= &page=
//   PATCH /reports/admin/:id       { action: 'dismiss'|'remove'|'suspend', note? }

const MAX_PER_DAY = 30;
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const firstMedia = (items) => (Array.isArray(items) && items.length ? items[0].thumbnailUrl || items[0].url || '' : '');

async function ownerName(userId) {
  if (!userId) return '';
  const u = await User.findById(userId).select('name username').lean();
  return u ? u.name || u.username || '' : '';
}

/** Finds the reported item. Returns { owner, text, mediaUrl } or null. */
async function loadTarget(type, id, me) {
  switch (type) {
    case 'post': {
      const p = await Post.findById(id).select('author caption mediaItems').lean();
      return p && { owner: p.author, text: p.caption, mediaUrl: firstMedia(p.mediaItems) };
    }
    case 'story': {
      const s = await Story.findById(id).select('author caption media').lean();
      return s && { owner: s.author, text: s.caption, mediaUrl: s.media ? s.media.thumbnailUrl || s.media.url : '' };
    }
    case 'user': {
      const u = await User.findById(id).select('name username').lean();
      return u && { owner: u._id, text: u.name || u.username || '', mediaUrl: '' };
    }
    case 'community': {
      const c = await Community.findById(id).select('createdBy name description iconUrl coverImageUrl').lean();
      return c && { owner: c.createdBy, text: `${c.name}${c.description ? ` — ${c.description}` : ''}`, mediaUrl: c.iconUrl || c.coverImageUrl || '' };
    }
    case 'community_post': {
      const p = await CommunityPost.findById(id).select('author text mediaItems').lean();
      return p && { owner: p.author, text: p.text, mediaUrl: firstMedia(p.mediaItems) };
    }
    case 'community_comment': {
      const c = await CommunityComment.findById(id).select('author text').lean();
      return c && { owner: c.author, text: c.text, mediaUrl: '' };
    }
    case 'community_message': {
      const m = await CommunityMessage.findById(id).select('sender text isRemoved').lean();
      return m && !m.isRemoved && { owner: m.sender, text: m.text, mediaUrl: '' };
    }
    case 'message': {
      const m = await Message.findById(id).select('conversation sender text').lean();
      if (!m) return null;
      // Only people in the chat can report its messages.
      const conv = await Conversation.findById(m.conversation).select('participants').lean();
      const inChat = conv && conv.participants.some((p) => String(p) === String(me));
      if (!inChat) return null;
      return { owner: m.sender, text: m.text, mediaUrl: '' };
    }
    default:
      return null;
  }
}

exports.createReport = catchAsync(async (req, res) => {
  const { targetType, targetId, reason } = req.body || {};
  const details = String((req.body && req.body.details) || '').trim().slice(0, 500);

  if (!Report.TARGET_TYPES.includes(targetType)) throw ApiError.badRequest('Unknown item type');
  if (!isId(targetId)) throw ApiError.badRequest('Invalid item');
  if (!Object.keys(Report.REASONS).includes(reason)) throw ApiError.badRequest('Please pick a reason');
  if (reason === 'other' && !details) throw ApiError.badRequest('Please tell us what is wrong');

  const target = await loadTarget(targetType, targetId, req.user._id);
  if (!target) throw ApiError.notFound('This item is no longer available');
  if (target.owner && String(target.owner) === String(req.user._id)) throw ApiError.badRequest('You can’t report your own content');

  const existing = await Report.findOne({ reporter: req.user._id, targetType, targetId }).select('_id').lean();
  if (existing) {
    return new ApiResponse(200, { alreadyReported: true, targetType, targetId }, 'You already reported this').send(res);
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const today = await Report.countDocuments({ reporter: req.user._id, createdAt: { $gte: since } });
  if (today >= MAX_PER_DAY) throw ApiError.badRequest('You’ve sent a lot of reports today. Please try again tomorrow.');

  try {
    await Report.create({
      reporter: req.user._id,
      targetType,
      targetId,
      targetOwner: target.owner || null,
      reason,
      details,
      snapshot: {
        text: String(target.text || '').slice(0, 1000),
        mediaUrl: target.mediaUrl || '',
        ownerName: await ownerName(target.owner),
      },
    });
  } catch (err) {
    // Two taps at once — the unique index caught the second one.
    if (err && err.code === 11000) {
      return new ApiResponse(200, { alreadyReported: true, targetType, targetId }, 'You already reported this').send(res);
    }
    throw err;
  }

  return new ApiResponse(201, { alreadyReported: false, targetType, targetId }, 'Thanks for reporting. Our team will review it within 24 hours.').send(res);
});

exports.myReports = catchAsync(async (req, res) => {
  const rows = await Report.find({ reporter: req.user._id }).select('targetType targetId').sort({ createdAt: -1 }).limit(2000).lean();
  return new ApiResponse(200, rows.map((r) => ({ targetType: r.targetType, targetId: String(r.targetId) }))).send(res);
});

// ---------------------------------------------------------------- admin

exports.adminList = catchAsync(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const status = String(req.query.status || 'pending');
  const type = String(req.query.type || '');

  const filter = {};
  if (status !== 'all') {
    if (!Report.STATUSES.includes(status)) throw ApiError.badRequest('Invalid status');
    filter.status = status;
  }
  if (type) {
    if (!Report.TARGET_TYPES.includes(type)) throw ApiError.badRequest('Invalid type');
    filter.targetType = type;
  }

  const [items, total, ...counts] = await Promise.all([
    Report.find(filter)
      .sort({ createdAt: status === 'pending' ? 1 : -1 }) // oldest pending first
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('reporter', 'name username email avatarUrl')
      .populate('targetOwner', 'name username email avatarUrl role isSuspended')
      .populate('reviewedBy', 'name')
      .lean(),
    Report.countDocuments(filter),
    ...Report.STATUSES.map((s) => Report.countDocuments({ status: s })),
  ]);

  // How many people reported the same item (helps decide quickly).
  const sameCounts = await Promise.all(items.map((r) => Report.countDocuments({ targetType: r.targetType, targetId: r.targetId })));

  const byStatus = {};
  Report.STATUSES.forEach((s, i) => (byStatus[s] = counts[i]));

  return new ApiResponse(200, {
    items: items.map((r, i) => ({ ...r, reasonLabel: Report.REASONS[r.reason] || r.reason, reportsOnItem: sameCounts[i] })),
    page,
    limit,
    total,
    hasMore: page * limit < total,
    counts: byStatus,
  }).send(res);
});

/** Deletes the reported item. Returns false if this type can't be removed. */
async function removeTarget(type, id) {
  switch (type) {
    case 'post':
      await Post.deleteOne({ _id: id });
      return true;
    case 'story':
      await Story.deleteOne({ _id: id });
      return true;
    case 'community_post':
      await CommunityComment.deleteMany({ post: id });
      await CommunityPost.deleteOne({ _id: id });
      return true;
    case 'community_comment': {
      const c = await CommunityComment.findById(id).select('post parentComment').lean();
      if (!c) return true;
      const replies = await CommunityComment.countDocuments({ parentComment: id });
      await CommunityComment.deleteMany({ parentComment: id });
      await CommunityComment.deleteOne({ _id: id });
      await CommunityPost.updateOne({ _id: c.post }, { $inc: { commentCount: -(1 + replies) } });
      if (c.parentComment) await CommunityComment.updateOne({ _id: c.parentComment }, { $inc: { replyCount: -1 } });
      return true;
    }
    case 'community_message':
      // Same as a moderator removing it in the chat.
      await CommunityMessage.updateOne({ _id: id }, { $set: { isRemoved: true } });
      return true;
    case 'message':
      await Message.deleteOne({ _id: id });
      return true;
    default:
      // Users and whole communities are handled with "suspend" instead.
      return false;
  }
}

exports.adminResolve = catchAsync(async (req, res) => {
  const { id } = req.params;
  const action = String((req.body && req.body.action) || '');
  const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
  if (!isId(id)) throw ApiError.badRequest('Invalid report');
  if (!['dismiss', 'remove', 'suspend'].includes(action)) throw ApiError.badRequest('Pick an action');

  const report = await Report.findById(id);
  if (!report) throw ApiError.notFound('Report not found');

  let status = 'dismissed';
  if (action === 'remove') {
    const ok = await removeTarget(report.targetType, report.targetId);
    if (!ok) throw ApiError.badRequest('This can’t be removed — suspend the account instead');
    status = 'removed';
  } else if (action === 'suspend') {
    if (!report.targetOwner) throw ApiError.badRequest('No account to suspend');
    const owner = await User.findById(report.targetOwner).select('role');
    if (!owner) throw ApiError.notFound('Account not found');
    if (owner.role === 'admin') throw ApiError.badRequest('Admin accounts can’t be suspended here');
    owner.isSuspended = true;
    await owner.save();
    // Also take the reported content down where possible.
    await removeTarget(report.targetType, report.targetId);
    status = 'suspended';
  }

  // Close every open report about the same item in one go.
  const update = { status, reviewedBy: req.user._id, reviewedAt: new Date(), adminNote: note };
  await Report.updateMany({ targetType: report.targetType, targetId: report.targetId, status: 'pending' }, { $set: update });
  if (report.status !== 'pending') {
    report.set(update);
    await report.save();
  }

  return new ApiResponse(200, { id, status }, status === 'dismissed' ? 'Report dismissed' : status === 'removed' ? 'Content removed' : 'Account suspended').send(res);
});