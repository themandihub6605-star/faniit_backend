const { User, Transaction, Withdrawal } = require('../models');
const walletService = require('../services/wallet.service');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');
const { TRANSACTION_STATUS } = require('../constants/enums');

const getMyWallet = catchAsync(async (req, res) => {
  const user = await User.findById(req.user._id);

  const recentTransactions = await Transaction.find({
    $or: [{ from: req.user._id }, { to: req.user._id }],
    status: { $in: [TRANSACTION_STATUS.SUCCESS, TRANSACTION_STATUS.RELEASED] },
  })
    .sort({ createdAt: -1 })
    .limit(5);

  return new ApiResponse(
    200,
    {
      // This is now the full gross amount the creator has earned (minus
      // any agency/referral cuts, which still happen at earn-time) —
      // platform fee is calculated and shown only when they withdraw,
      // not baked into this number. See wallet.service.js.
      balance: user.walletBalance,
      isPlusMember: user.isPlusMember,
      isFoundingMember: user.isFoundingMember,
      recentTransactions,
    },
    'Wallet fetched'
  ).send(res);
});

/** GET /api/wallet/withdraw/preview?amount=<paise> — lets the frontend show
 * "you'll receive ₹X after platform fee" before the user commits to a
 * withdrawal request, using the same fee calculation requestWithdrawal
 * itself will apply. */
const previewWithdrawal = catchAsync(async (req, res) => {
  const amount = Number(req.query.amount);
  if (!amount || amount <= 0) throw ApiError.badRequest('Enter a valid amount');

  const platformFeePercent = await walletService.getPlatformFeePercentFor(req.user);
  const platformFee = Math.round((amount * platformFeePercent) / 100);
  const netPayoutAmount = amount - platformFee;

  return new ApiResponse(200, { amount, platformFeePercent, platformFee, netPayoutAmount }, 'Withdrawal preview').send(res);
});

/** POST /api/wallet/withdraw — the requested (gross) amount is held
 * immediately (deducted from the wallet) so it can't be requested twice;
 * if Admin rejects it, the full requested amount is refunded back to the
 * wallet. Platform fee is calculated once here, from the creator's
 * CURRENT plan, and frozen on the Withdrawal record — it won't change
 * even if their plan changes while this request is still pending. */
const requestWithdrawal = catchAsync(async (req, res) => {
  const { amount, payoutMethod, payoutDetails } = req.body;
  if (!amount || amount <= 0) throw ApiError.badRequest('Enter a valid amount');
  if (!['upi', 'bank'].includes(payoutMethod)) throw ApiError.badRequest('payoutMethod must be upi or bank');
  if (!payoutDetails) throw ApiError.badRequest('Payout details are required');

  const user = await User.findById(req.user._id);
  if (user.walletBalance < amount) throw ApiError.badRequest('Insufficient wallet balance');

  const platformFeePercent = await walletService.getPlatformFeePercentFor(user);
  const platformFee = Math.round((amount * platformFeePercent) / 100);
  const netPayoutAmount = amount - platformFee;

  user.walletBalance -= amount;
  await user.save();

  const withdrawal = await Withdrawal.create({
    user: user._id,
    amount,
    platformFeePercent,
    platformFee,
    netPayoutAmount,
    payoutMethod,
    payoutDetails,
    status: 'initiated',
  });

  return new ApiResponse(
    201,
    withdrawal,
    `Withdrawal requested — ₹${(netPayoutAmount / 100).toFixed(2)} will be sent to your ${payoutMethod === 'upi' ? 'UPI ID' : 'bank account'} within 72 hours, after platform fee.`
  ).send(res);
});

const getMyWithdrawals = catchAsync(async (req, res) => {
  const withdrawals = await Withdrawal.find({ user: req.user._id }).sort({ createdAt: -1 });
  return new ApiResponse(200, withdrawals, 'Withdrawals fetched').send(res);
});

module.exports = { getMyWallet, previewWithdrawal, requestWithdrawal, getMyWithdrawals };