// File: src/FanittStore/services/attendance.service.js
const mongoose = require('mongoose');
const log = require('../utils/logger');

// Who joined a Virtual Meet or a live stream, when, and for how long.
// Filled from LiveKit webhooks (participant_joined / participant_left /
// room_finished), so it works for every device without the app sending
// anything. One row per person per meet/live; each visit is kept.

const visitSchema = new mongoose.Schema(
  {
    joinedAt: { type: Date, required: true },
    leftAt: { type: Date, default: null },
  },
  { _id: false }
);

const attendanceSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['meet', 'live'], required: true },
    ref: { type: mongoose.Schema.Types.ObjectId, required: true }, // Session id (meet) or LiveStream id (live)
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    identity: { type: String, required: true },
    name: { type: String, default: '' },
    isHost: { type: Boolean, default: false },
    visits: { type: [visitSchema], default: [] },
    totalSeconds: { type: Number, default: 0 }, // closed visits only
    firstJoinedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'roomattendances' }
);
attendanceSchema.index({ kind: 1, ref: 1, identity: 1 }, { unique: true });
attendanceSchema.index({ kind: 1, ref: 1, firstJoinedAt: 1 });

const Attendance = mongoose.models.RoomAttendance || mongoose.model('RoomAttendance', attendanceSchema);

const seconds = (from, to) => Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 1000));

/** Someone entered the room. */
async function onJoin({ kind, ref, identity, name, isHost, at = new Date() }) {
  try {
    const user = mongoose.isValidObjectId(identity) ? identity : null;
    const doc = await Attendance.findOneAndUpdate(
      { kind, ref, identity: String(identity) },
      {
        $setOnInsert: { user, firstJoinedAt: at },
        $set: { name: name || '', isHost: Boolean(isHost), lastSeenAt: at },
      },
      { upsert: true, new: true }
    );
    // Close a visit left open (missed "left" event) before starting a new one.
    const open = doc.visits.find((v) => !v.leftAt);
    if (open) {
      open.leftAt = at;
      doc.totalSeconds += seconds(open.joinedAt, at);
    }
    doc.visits.push({ joinedAt: at });
    if (doc.visits.length > 50) doc.visits = doc.visits.slice(-50);
    await doc.save();
  } catch (err) {
    log.warn('attendance.join_failed', { kind, ref: String(ref), message: err?.message });
  }
}

/** Someone left the room. */
async function onLeave({ kind, ref, identity, at = new Date() }) {
  try {
    const doc = await Attendance.findOne({ kind, ref, identity: String(identity) });
    if (!doc) return;
    const open = doc.visits.find((v) => !v.leftAt);
    if (open) {
      open.leftAt = at;
      doc.totalSeconds += seconds(open.joinedAt, at);
    }
    doc.lastSeenAt = at;
    await doc.save();
  } catch (err) {
    log.warn('attendance.leave_failed', { kind, ref: String(ref), message: err?.message });
  }
}

/** The room closed: everyone still inside has left now. */
async function closeAll({ kind, ref, at = new Date() }) {
  try {
    const docs = await Attendance.find({ kind, ref, 'visits.leftAt': null });
    for (const doc of docs) {
      const open = doc.visits.find((v) => !v.leftAt);
      if (!open) continue;
      open.leftAt = at;
      doc.totalSeconds += seconds(open.joinedAt, at);
      doc.lastSeenAt = at;
      // eslint-disable-next-line no-await-in-loop
      await doc.save();
    }
  } catch (err) {
    log.warn('attendance.close_failed', { kind, ref: String(ref), message: err?.message });
  }
}

/**
 * The host's report: everyone who joined (host left out), longest first.
 * A visit still open counts up to now.
 */
async function report({ kind, ref }) {
  const User = mongoose.models.User;
  const rows = await Attendance.find({ kind, ref, isHost: false }).lean();
  const users = User && rows.length ? await User.find({ _id: { $in: rows.map((r) => r.user).filter(Boolean) } }).select('name avatarUrl role').lean() : [];
  const byId = new Map(users.map((u) => [String(u._id), u]));
  const now = new Date();

  const people = rows.map((r) => {
    const open = r.visits.find((v) => !v.leftAt);
    const total = r.totalSeconds + (open ? seconds(open.joinedAt, now) : 0);
    const u = r.user ? byId.get(String(r.user)) : null;
    return {
      userId: r.user || null,
      name: u?.name || r.name || 'Guest',
      avatarUrl: u?.avatarUrl || '',
      role: u?.role || '',
      firstJoinedAt: r.firstJoinedAt,
      lastSeenAt: r.lastSeenAt,
      visits: r.visits.length,
      watchedSeconds: total,
      inRoomNow: Boolean(open),
    };
  });
  people.sort((a, b) => b.watchedSeconds - a.watchedSeconds);

  const totalSeconds = people.reduce((s, p) => s + p.watchedSeconds, 0);
  return {
    totalPeople: people.length,
    inRoomNow: people.filter((p) => p.inRoomNow).length,
    averageSeconds: people.length ? Math.round(totalSeconds / people.length) : 0,
    totalSeconds,
    people,
  };
}

module.exports = { Attendance, onJoin, onLeave, closeAll, report };