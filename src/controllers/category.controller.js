const { Category } = require('../models');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');

const listCategories = catchAsync(async (req, res) => {
  const categories = await Category.find({ isActive: true }).sort({ label: 1 });
  return new ApiResponse(200, categories, 'Categories fetched').send(res);
});

module.exports = { listCategories };
