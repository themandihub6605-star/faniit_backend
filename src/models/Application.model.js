const mongoose = require('mongoose');
const { APPLICATION_STATUS } = require('../constants/enums');

const applicationSchema = new mongoose.Schema(
  {
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: 'CreatorProfile', required: true, index: true },

    pitch: { type: String, maxlength: 1000, default: '' },
    status: { type: String, enum: Object.values(APPLICATION_STATUS), default: APPLICATION_STATUS.PENDING },
  },
  { timestamps: true }
);

applicationSchema.index({ campaign: 1, creator: 1 }, { unique: true });

module.exports = mongoose.model('Application', applicationSchema);
