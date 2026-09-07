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
    `Withdrawal requested — ₹${(netPayoutAmount / 100).toFixed(2)} will be sent to your ${payoutMethod === 'upi' ? 'UPI ID' : 'bank account'} within 48 hours, after platform fee.`
  ).send(res);
});

const getMyWithdrawals = catchAsync(async (req, res) => {
  const withdrawals = await Withdrawal.find({ user: req.user._id }).sort({ createdAt: -1 });
  return new ApiResponse(200, withdrawals, 'Withdrawals fetched').send(res);
});

/** GET /api/wallet/transactions — full, paginated transaction history,
 * every type and status (not just the 5-item SUCCESS/RELEASED preview
 * getMyWallet returns for the balance card). Each transaction gets a
 * `direction` field ('credit'/'debit' relative to the requesting user)
 * computed server-side so the frontend never has to compare user IDs
 * itself — just read direction and color/sign accordingly. */
const getMyTransactions = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, type, status } = req.query;
  const filter = { $or: [{ from: req.user._id }, { to: req.user._id }] };
  if (type) filter.type = type;
  if (status) filter.status = status;

  const [transactions, total] = await Promise.all([
    Transaction.find(filter)
      .populate('from', 'name email')
      .populate('to', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit)),
    Transaction.countDocuments(filter),
  ]);

  // toObject() carries every field on the document (razorpay ids,
  // commission breakdown, escrow timestamps, notes, etc.) — nothing extra
  // to add here beyond `direction`, which is what the tap-to-expand
  // detail view on the frontend needs.
  const withDirection = transactions.map((t) => {
    const obj = t.toObject();
    obj.direction = t.to && String(t.to._id || t.to) === String(req.user._id) ? 'credit' : 'debit';
    return obj;
  });

  return new ApiResponse(
    200,
    { transactions: withDirection, total, page: Number(page), pages: Math.ceil(total / Number(limit)) },
    'Transactions fetched'
  ).send(res);
});

module.exports = { getMyWallet, previewWithdrawal, requestWithdrawal, getMyWithdrawals, getMyTransactions };