const { User, Transaction } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
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

module.exports = { getMyWallet };