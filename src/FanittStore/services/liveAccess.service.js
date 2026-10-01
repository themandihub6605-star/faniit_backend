const mongoose = require('mongoose');
const { LIVE_VISIBILITY, LIVE_PRIVATE_MODE } = require('../constants');
const { LiveStream } = require('../models');
const orderService = require('./order.service');

// Decides who may watch a live. Returns
//   { allowed, isHost, needsTicket, reason }
// where `allowed` means "may join now" and `needsTicket` means "allowed
// once they buy a ticket".

async function isCommunityMember(userId, communityId) {
  if (!communityId) return false;
  // The Community feature lives outside the store; read its membership
  // collection directly so the store doesn't depend on its internals.
  const Membership = mongoose.models.CommunityMembership;
  if (!Membership) return false;
  return Boolean(await Membership.exists({ community: communityId, user: userId, status: 'active' }));
}

async function checkAccess(live, user, { inviteCode } = {}) {
  if (!user) return { allowed: false, isHost: false, needsTicket: false, reason: 'login_required' };
  const isHost = String(live.host) === String(user._id);
  if (isHost || user.role === 'admin') return { allowed: true, isHost, needsTicket: false, reason: null };

  if (live.visibility === LIVE_VISIBILITY.PRIVATE) {
    let passes = false;
    if (live.privateMode === LIVE_PRIVATE_MODE.INVITE) {
      const alreadyInvited = (live.invitedUsers || []).some((id) => String(id) === String(user._id));
      if (alreadyInvited) passes = true;
      else if (inviteCode && live.inviteCode && inviteCode === live.inviteCode) {
        // Remember them so they don't need the link again.
        await LiveStream.updateOne({ _id: live._id }, { $addToSet: { invitedUsers: user._id } });
        passes = true;
      }
    } else if (live.privateMode === LIVE_PRIVATE_MODE.COMMUNITY) {
      passes = await isCommunityMember(user._id, live.community);
    } else if (live.privateMode === LIVE_PRIVATE_MODE.SELECTED) {
      passes = (live.allowedUsers || []).some((id) => String(id) === String(user._id));
    }
    if (!passes) return { allowed: false, isHost: false, needsTicket: false, reason: 'private' };
  }

  if (live.price > 0 && !(await orderService.hasPaidAccess(user._id, live._id))) {
    return { allowed: false, isHost: false, needsTicket: true, reason: 'ticket_required' };
  }
  return { allowed: true, isHost: false, needsTicket: false, reason: null };
}

module.exports = { checkAccess };
