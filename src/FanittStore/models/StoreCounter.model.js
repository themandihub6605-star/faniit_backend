const mongoose = require('mongoose');

// Atomic sequences, e.g. invoice numbers per year.
const storeCounterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

storeCounterSchema.statics.next = async function next(name) {
  const doc = await this.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true });
  return doc.seq;
};

module.exports = mongoose.models.StoreCounter || mongoose.model('StoreCounter', storeCounterSchema);
