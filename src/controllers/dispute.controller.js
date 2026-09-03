const disputeService = require('../services/dispute.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { DISPUTE_OUTCOME } = require('../constants/enums');

// GET /disputes — admin-only, every open dispute awaiting resolution.
const listOpenDisputes = catchAsync(async (req, res) => {
  const disputes = await disputeService.getOpenDisputes();
  return new ApiResponse(200, disputes, 'Open disputes fetched').send(res);
});

// GET /disputes/:id — admin-only, full detail for one dispute (both sides'
// evidence, the submission being disputed).
const getDispute = catchAsync(async (req, res) => {
  const dispute = await disputeService.getDisputeById(req.params.id);
  return new ApiResponse(200, dispute, 'Dispute fetched').send(res);
});

// PATCH /disputes/:id/resolve — admin's decision. Body: { outcome,
// creatorAmount? (required only for 'partial'), adminNotes? }
const resolveDispute = catchAsync(async (req, res) => {
  const { outcome, creatorAmount, adminNotes } = req.body;
  if (!Object.values(DISPUTE_OUTCOME).includes(outcome)) {
    throw ApiError.badRequest('Invalid outcome');
  }

  const dispute = await disputeService.resolveDispute({
    disputeId: req.params.id,
    adminUserId: req.user._id,
    outcome,
    creatorAmount: creatorAmount != null ? Number(creatorAmount) : null,
    adminNotes,
  });

  return new ApiResponse(200, dispute, 'Dispute resolved').send(res);
});

module.exports = { listOpenDisputes, getDispute, resolveDispute };