const mongoose = require('mongoose');
const catchAsync = require('../../utils/catchAsync');
const ApiResponse = require('../../utils/apiResponse');
const ApiError = require('../../utils/apiError');
const { User } = require('../../models');
const { LiveStream, StoreOrder, Store } = require('../models');
const { LIVE_STATUS, LIVE_VISIBILITY, LIVE_PRIVATE_MODE, ORDER_ITEM, ORDER_STATUS, STORE_STATUS } = require('../constants');
const storeService = require('../services/store.service');
const liveService = require('../services/live.service');
const liveAccess = require('../services/liveAccess.service');
const orderService = require('../services/order.service');
const { order: serializeOrder } = require('../utils/serialize');
const { pageParams } = require('../utils/text');
const log = require('../utils/logger');

// Live streams — creator side (/me/lives) and viewer side (/lives).

function assertObjectId(id) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('Live not found');
}

/** Public shape: never includes the room name, invite code or user lists. */
function publicLive(live, extra = {}) {
  return {
    _id: live._id,
    store: live.store,
    host: live.host,
    title: live.title,
    description: live.description,
    coverUrl: live.coverUrl,
    visibility: live.visibility,
    privateMode: live.privateMode,
    price: live.price,
    isFree: live.price === 0,
    chatEnabled: live.chatEnabled,
    fanboxEnabled: live.fanboxEnabled,
    status: live.status,
    scheduledAt: live.scheduledAt,
    startedAt: live.startedAt,
    endedAt: live.endedAt,
    viewers: live.stats?.currentViewers || 0,
    createdAt: live.createdAt,
    ...extra,
  };
}

/** Owner shape: + invite link code, audience settings, full stats. */
function ownerLive(live) {
  return publicLive(live, {
    inviteCode: live.privateMode === LIVE_PRIVATE_MODE.INVITE ? live.inviteCode : '',
    community: live.community,
    allowedUsers: live.allowedUsers,
    stats: live.stats,
    cancelledReason: live.cancelledReason,
    endedByAdmin: live.endedByAdmin,
  });
}

async function applyAudience(live, body, hostId) {
  if (body.visibility !== undefined) live.visibility = body.visibility;
  if (live.visibility === LIVE_VISIBILITY.PUBLIC) {
    live.privateMode = null;
    live.community = null;
    live.allowedUsers = [];
    return;
  }
  if (body.privateMode !== undefined) live.privateMode = body.privateMode;
  if (!live.privateMode) throw ApiError.badRequest('Choose who can watch this private live');

  if (live.privateMode === LIVE_PRIVATE_MODE.INVITE && !live.inviteCode) live.inviteCode = liveService.newInviteCode();

  if (live.privateMode === LIVE_PRIVATE_MODE.COMMUNITY) {
    const communityId = body.communityId !== undefined ? body.communityId : live.community;
    if (!communityId) throw ApiError.badRequest('Choose the community');
    const Community = mongoose.models.Community;
    const Membership = mongoose.models.CommunityMembership;
    const owns =
      Community && Membership
        ? await Membership.exists({ community: communityId, user: hostId, status: 'active', role: { $in: ['admin', 'moderator'] } })
        : null;
    if (!owns) throw ApiError.badRequest('You can only pick a community you run');
    live.community = communityId;
  }

  if (live.privateMode === LIVE_PRIVATE_MODE.SELECTED) {
    const ids = body.allowedUserIds !== undefined ? body.allowedUserIds : live.allowedUsers.map(String);
    const unique = [...new Set(ids.map(String))].filter((id) => id !== String(hostId));
    if (!unique.length) throw ApiError.badRequest('Pick at least one person');
    const found = await User.countDocuments({ _id: { $in: unique } });
    if (found !== unique.length) throw ApiError.badRequest('Some of the selected people no longer exist');
    live.allowedUsers = unique;
  }
}

// ---------- creator ----------

/** POST /api/store/me/lives */
const createLive = catchAsync(async (req, res) => {
  const store = await storeService.requireActiveStore(req.user._id);
  const live = new LiveStream({
    store: store._id,
    host: req.user._id,
    title: req.body.title,
    description: req.body.description || '',
    price: req.body.price || 0,
    chatEnabled: req.body.chatEnabled ?? true,
    fanboxEnabled: req.body.fanboxEnabled ?? true,
    scheduledAt: req.body.scheduledAt ? new Date(req.body.scheduledAt) : null,
    roomName: liveService.newRoomName('live'),
  });
  await applyAudience(live, { ...req.body, visibility: req.body.visibility || LIVE_VISIBILITY.PUBLIC }, req.user._id);
  await live.save();
  log.info('live.created', { liveId: String(live._id), scheduled: Boolean(live.scheduledAt) });
  return new ApiResponse(201, ownerLive(live), 'Live created').send(res);
});

async function loadOwnLive(userId, id) {
  assertObjectId(id);
  const live = await LiveStream.findOne({ _id: id, host: userId });
  if (!live) throw ApiError.notFound('Live not found');
  return live;
}

/** GET /api/store/me/lives?status= */
const listMyLives = catchAsync(async (req, res) => {
  const filter = { host: req.user._id };
  if (Object.values(LIVE_STATUS).includes(req.query.status)) filter.status = req.query.status;
  const lives = await LiveStream.find(filter).sort({ createdAt: -1 }).limit(100);
  return new ApiResponse(200, lives.map(ownerLive), 'Lives fetched').send(res);
});

/** GET /api/store/me/lives/:id — with ticket buyers. */
const getMyLive = catchAsync(async (req, res) => {
  const live = await loadOwnLive(req.user._id, req.params.id);
  const tickets = await StoreOrder.find({ itemId: live._id, itemType: ORDER_ITEM.LIVE_STREAM, status: { $in: [ORDER_STATUS.PAID, ORDER_STATUS.REFUNDED] } })
    .populate('buyer', 'name avatarUrl')
    .sort({ paidAt: -1 })
    .limit(500);
  return new ApiResponse(200, { live: ownerLive(live), tickets: tickets.map(serializeOrder) }, 'Live fetched').send(res);
});

/** PATCH /api/store/me/lives/:id — only while scheduled. */
const updateLive = catchAsync(async (req, res) => {
  const live = await loadOwnLive(req.user._id, req.params.id);
  if (live.status !== LIVE_STATUS.SCHEDULED) throw ApiError.badRequest('Only scheduled lives can be edited');
  if (req.body.price !== undefined && req.body.price !== live.price && live.stats.ticketsSold > 0) {
    throw ApiError.badRequest("Tickets are already sold — the price can't change");
  }
  ['title', 'description', 'price', 'chatEnabled', 'fanboxEnabled'].forEach((f) => {
    if (req.body[f] !== undefined) live[f] = req.body[f];
  });
  if (req.body.scheduledAt !== undefined) live.scheduledAt = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;
  if (['visibility', 'privateMode', 'communityId', 'allowedUserIds'].some((f) => req.body[f] !== undefined)) {
    await applyAudience(live, req.body, req.user._id);
  }
  await live.save();
  return new ApiResponse(200, ownerLive(live), 'Live updated').send(res);
});

/** POST /api/store/me/lives/:id/cover (multipart "image") */
const uploadLiveCover = catchAsync(async (req, res) => {
  if (!req.file?.path) throw ApiError.badRequest('Choose a cover image');
  const live = await loadOwnLive(req.user._id, req.params.id);
  live.coverUrl = req.file.path;
  await live.save();
  return new ApiResponse(200, ownerLive(live), 'Cover updated').send(res);
});

/** POST /api/store/me/lives/:id/start — goes live, returns the host token. */
const startLive = catchAsync(async (req, res) => {
  await storeService.requireActiveStore(req.user._id);
  const live = await loadOwnLive(req.user._id, req.params.id);
  const connection = await liveService.start(live, req.user);
  const fresh = await LiveStream.findById(live._id);
  return new ApiResponse(200, { live: ownerLive(fresh), connection }, 'You are live').send(res);
});

/** POST /api/store/me/lives/:id/end */
const endLive = catchAsync(async (req, res) => {
  const live = await loadOwnLive(req.user._id, req.params.id);
  const ended = await liveService.end(live);
  return new ApiResponse(200, ownerLive(ended), 'Live ended').send(res);
});

/** POST /api/store/me/lives/:id/cancel { reason } — refunds every ticket. */
const cancelLive = catchAsync(async (req, res) => {
  const live = await loadOwnLive(req.user._id, req.params.id);
  const result = await liveService.cancel(live, { byUserId: req.user._id, reason: req.body.reason });
  return new ApiResponse(
    200,
    { live: ownerLive(result.live), refunded: result.refunded, failedOrderIds: result.failedOrderIds },
    result.failedOrderIds.length ? 'Live cancelled — some refunds need a retry from support' : 'Live cancelled and tickets refunded'
  ).send(res);
});

// ---------- viewers ----------

async function loadVisibleLive(id) {
  assertObjectId(id);
  const live = await LiveStream.findById(id);
  if (!live) throw ApiError.notFound('Live not found');
  const store = await Store.findById(live.store).select('status name slug logoUrl user');
  if (!store || store.status !== STORE_STATUS.ACTIVE) throw ApiError.notFound('Live not found');
  return { live, store };
}

/** GET /api/store/lives?status=live|scheduled&page= — public lives only. */
const listLives = catchAsync(async (req, res) => {
  const { page, limit, skip } = pageParams(req.query);
  const status = req.query.status === LIVE_STATUS.SCHEDULED ? LIVE_STATUS.SCHEDULED : LIVE_STATUS.LIVE;
  const filter = { status, visibility: LIVE_VISIBILITY.PUBLIC };
  if (status === LIVE_STATUS.SCHEDULED) filter.scheduledAt = { $gte: new Date(Date.now() - 60 * 60 * 1000) };
  const activeStores = await Store.find({ status: STORE_STATUS.ACTIVE }).distinct('_id');
  filter.store = { $in: activeStores };
  const [lives, total] = await Promise.all([
    LiveStream.find(filter)
      .populate('store', 'name slug logoUrl')
      .sort(status === LIVE_STATUS.LIVE ? { 'stats.currentViewers': -1, startedAt: -1 } : { scheduledAt: 1 })
      .skip(skip)
      .limit(limit),
    LiveStream.countDocuments(filter),
  ]);
  return new ApiResponse(200, { lives: lives.map((l) => publicLive(l)), total, page, pages: Math.ceil(total / limit) }, 'Lives fetched').send(
    res
  );
});

// ---------- discovery: home screen + community screen ----------

const OPEN_STATUSES = [LIVE_STATUS.LIVE, LIVE_STATUS.SCHEDULED];
const openLiveFilter = () => ({
  $or: [{ status: LIVE_STATUS.LIVE }, { status: LIVE_STATUS.SCHEDULED, scheduledAt: { $gte: new Date(Date.now() - 60 * 60 * 1000) } }],
});

async function myCommunityIds(userId) {
  const Membership = mongoose.models.CommunityMembership;
  if (!userId || !Membership) return [];
  return Membership.find({ user: userId, status: 'active' }).distinct('community');
}

/** Who a live is for, in words the app can show on the card. */
function audienceOf(live, communities) {
  if (live.visibility !== LIVE_VISIBILITY.PRIVATE) return { type: 'everyone' };
  if (live.privateMode === LIVE_PRIVATE_MODE.COMMUNITY) {
    const c = communities.get(String(live.community)) || null;
    return { type: 'community', communityId: live.community || null, communityName: c?.name || '', communitySlug: c?.slug || '', communityIconUrl: c?.iconUrl || '' };
  }
  if (live.privateMode === LIVE_PRIVATE_MODE.SELECTED) return { type: 'selected' };
  return { type: 'invite' };
}

/** Lives + store, host, community and "my ticket" info for cards. */
async function enrichLives(lives, user) {
  if (!lives.length) return [];
  const Community = mongoose.models.Community;
  const communityIds = [...new Set(lives.map((l) => l.community).filter(Boolean).map(String))];
  const [stores, hosts, communities, tickets] = await Promise.all([
    Store.find({ _id: { $in: lives.map((l) => l.store) } }).select('name slug logoUrl'),
    User.find({ _id: { $in: lives.map((l) => l.host) } }).select('name avatarUrl'),
    communityIds.length && Community ? Community.find({ _id: { $in: communityIds } }).select('name slug iconUrl') : [],
    user
      ? StoreOrder.find({ buyer: user._id, itemId: { $in: lives.map((l) => l._id) }, status: ORDER_STATUS.PAID }).distinct('itemId')
      : [],
  ]);
  const storeMap = new Map(stores.map((x) => [String(x._id), x]));
  const hostMap = new Map(hosts.map((x) => [String(x._id), x]));
  const communityMap = new Map(communities.map((x) => [String(x._id), x]));
  const ticketSet = new Set(tickets.map(String));

  return lives.map((l) => {
    const st = storeMap.get(String(l.store));
    const h = hostMap.get(String(l.host));
    const isHost = Boolean(user) && String(l.host) === String(user._id);
    return publicLive(l, {
      store: st ? { _id: st._id, name: st.name, slug: st.slug, logoUrl: st.logoUrl } : l.store,
      hostInfo: { name: h?.name || '', avatarUrl: h?.avatarUrl || '' },
      audience: audienceOf(l, communityMap),
      me: { isHost, hasTicket: isHost || ticketSet.has(String(l._id)) },
    });
  });
}

function sortOpenLives(lives) {
  return lives.sort((a, b) => {
    const aLive = a.status === LIVE_STATUS.LIVE ? 1 : 0;
    const bLive = b.status === LIVE_STATUS.LIVE ? 1 : 0;
    if (aLive !== bLive) return bLive - aLive;
    if (aLive) return (b.stats?.currentViewers || 0) - (a.stats?.currentViewers || 0);
    return new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0);
  });
}

/**
 * GET /api/store/lives/discover — live + upcoming lives this person can
 * watch: public ones, plus private ones they're allowed into (their
 * communities, hand-picked, invite already used, or their own).
 */
const discoverLives = catchAsync(async (req, res) => {
  const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const activeStores = await Store.find({ status: STORE_STATUS.ACTIVE }).distinct('_id');
  const audience = [{ visibility: LIVE_VISIBILITY.PUBLIC }];
  if (req.user) {
    const uid = req.user._id;
    const communities = await myCommunityIds(uid);
    audience.push(
      { host: uid },
      { visibility: LIVE_VISIBILITY.PRIVATE, privateMode: LIVE_PRIVATE_MODE.SELECTED, allowedUsers: uid },
      { visibility: LIVE_VISIBILITY.PRIVATE, privateMode: LIVE_PRIVATE_MODE.INVITE, invitedUsers: uid }
    );
    if (communities.length) {
      audience.push({ visibility: LIVE_VISIBILITY.PRIVATE, privateMode: LIVE_PRIVATE_MODE.COMMUNITY, community: { $in: communities } });
    }
  }
  const lives = await LiveStream.find({ store: { $in: activeStores }, $and: [openLiveFilter(), { $or: audience }] })
    .sort({ status: 1, scheduledAt: 1 })
    .limit(60);
  const visible = sortOpenLives(lives).slice(0, limit);
  return new ApiResponse(200, { lives: await enrichLives(visible, req.user) }, 'Lives fetched').send(res);
});

/**
 * GET /api/store/lives/community/:communityId — lives made for this
 * community. Non-members see them too (locked), so they know to join.
 */
const communityLives = catchAsync(async (req, res) => {
  const { communityId } = req.params;
  if (!mongoose.isValidObjectId(communityId)) throw ApiError.notFound('Community not found');
  const activeStores = await Store.find({ status: STORE_STATUS.ACTIVE }).distinct('_id');
  const lives = await LiveStream.find({
    store: { $in: activeStores },
    visibility: LIVE_VISIBILITY.PRIVATE,
    privateMode: LIVE_PRIVATE_MODE.COMMUNITY,
    community: communityId,
    ...openLiveFilter(),
  }).limit(20);

  const Membership = mongoose.models.CommunityMembership;
  const isMember = Boolean(req.user && Membership && (await Membership.exists({ community: communityId, user: req.user._id, status: 'active' })));
  return new ApiResponse(200, { lives: await enrichLives(sortOpenLives(lives), req.user), isMember }, 'Community lives').send(res);
});

/** GET /api/store/lives/:id?invite=CODE — details + what this user can do. */
const getLive = catchAsync(async (req, res) => {
  const { live, store } = await loadVisibleLive(req.params.id);
  const access = await liveAccess.checkAccess(live, req.user, { inviteCode: req.query.invite });
  // Private lives only show details to people who pass the audience check.
  if (live.visibility === LIVE_VISIBILITY.PRIVATE && access.reason === 'private') {
    return new ApiResponse(
      200,
      { live: { _id: live._id, title: 'Private live', status: live.status, visibility: live.visibility, privateMode: live.privateMode }, store, access },
      'This live is private'
    ).send(res);
  }
  return new ApiResponse(200, { live: publicLive(live), store, access }, 'Live fetched').send(res);
});

/** POST /api/store/lives/:id/checkout { payWith?, invite? } — buy a ticket. */
const buyTicket = catchAsync(async (req, res) => {
  const { live, store } = await loadVisibleLive(req.params.id);
  if (![LIVE_STATUS.SCHEDULED, LIVE_STATUS.LIVE].includes(live.status)) throw ApiError.badRequest('This live has finished');
  const access = await liveAccess.checkAccess(live, req.user, { inviteCode: req.body.invite });
  if (access.isHost) throw ApiError.badRequest("You don't need a ticket for your own live");
  if (access.allowed) throw ApiError.conflict('You already have access', [], 'ALREADY_OWNED');
  if (!access.needsTicket) throw ApiError.forbidden('This live is private', [], 'LIVE_PRIVATE');

  const result = await orderService.startCheckout(
    req.user,
    {
      store,
      itemType: ORDER_ITEM.LIVE_STREAM,
      itemId: live._id,
      itemTitle: live.title,
      itemCoverUrl: live.coverUrl,
      amount: live.price,
      reusePending: true,
    },
    { payWith: req.body.payWith }
  );
  return new ApiResponse(
    result.paid ? 201 : 200,
    { order: serializeOrder(result.order), paid: result.paid, razorpay: result.razorpay },
    result.paid ? 'Ticket confirmed' : 'Complete the payment'
  ).send(res);
});

/** POST /api/store/lives/:id/join { invite? } — viewer token (host gets a host token). */
const joinLive = catchAsync(async (req, res) => {
  const { live } = await loadVisibleLive(req.params.id);
  if (live.status !== LIVE_STATUS.LIVE) {
    throw ApiError.badRequest(live.status === LIVE_STATUS.SCHEDULED ? "This live hasn't started yet" : 'This live has ended', [], 'LIVE_NOT_RUNNING');
  }
  const access = await liveAccess.checkAccess(live, req.user, { inviteCode: req.body.invite });
  if (!access.allowed) {
    if (access.needsTicket) throw ApiError.forbidden('Get a ticket to watch this live', [], 'TICKET_REQUIRED');
    throw ApiError.forbidden('This live is private', [], 'LIVE_PRIVATE');
  }
  const connection = access.isHost ? await liveService.hostToken(live, req.user) : await liveService.viewerToken(live, req.user);
  return new ApiResponse(200, { live: publicLive(live), connection, role: access.isHost ? 'host' : 'viewer' }, 'Joining').send(res);
});

module.exports = {
  publicLive,
  createLive,
  listMyLives,
  getMyLive,
  updateLive,
  uploadLiveCover,
  startLive,
  endLive,
  cancelLive,
  listLives,
  discoverLives,
  communityLives,
  getLive,
  buyTicket,
  joinLive,
};