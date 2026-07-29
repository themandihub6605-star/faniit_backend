const { User, Transaction, Withdrawal } = require('../models');
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
      balance: user.walletBalance,
      isPlusMember: user.isPlusMember,
      isFoundingMember: user.isFoundingMember,
      recentTransactions,
    },
    'Wallet fetched'
  ).send(res);
});

/** POST /api/wallet/withdraw — the amount is held immediately (deducted
 * from the wallet) so it can't be requested twice; if Admin rejects it,
 * the amount is refunded back to the wallet. */
const requestWithdrawal = catchAsync(async (req, res) => {
  const { amount, payoutMethod, payoutDetails } = req.body;
  if (!amount || amount <= 0) throw ApiError.badRequest('Enter a valid amount');
  if (!['upi', 'bank'].includes(payoutMethod)) throw ApiError.badRequest('payoutMethod must be upi or bank');
  if (!payoutDetails) throw ApiError.badRequest('Payout details are required');

  const user = await User.findById(req.user._id);
  if (user.walletBalance < amount) throw ApiError.badRequest('Insufficient wallet balance');

  user.walletBalance -= amount;
  await user.save();

  const withdrawal = await Withdrawal.create({
    user: user._id,
    amount,
    payoutMethod,
    payoutDetails,
  });

  return new ApiResponse(201, withdrawal, 'Withdrawal requested — funds are held until it is processed').send(res);
});

const getMyWithdrawals = catchAsync(async (req, res) => {
  const withdrawals = await Withdrawal.find({ user: req.user._id }).sort({ createdAt: -1 });
  return new ApiResponse(200, withdrawals, 'Withdrawals fetched').send(res);
});

module.exports = { getMyWallet, requestWithdrawal, getMyWithdrawals };