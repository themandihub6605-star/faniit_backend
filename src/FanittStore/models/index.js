// Fanitt Store models. Loaded once when the Store router is mounted.
const stats = require('./StoreStat.model');

module.exports = {
  Store: require('./Store.model'),
  StoreSettings: require('./StoreSettings.model'),
  DigitalProduct: require('./DigitalProduct.model'),
  StoreOrder: require('./StoreOrder.model'),
  StoreCounter: require('./StoreCounter.model'),
  LiveStream: require('./LiveStream.model'),
  CallSession: require('./CallSession.model'),
  AffiliateProduct: require('./AffiliateProduct.model'),
  AffiliateCollection: require('./AffiliateCollection.model'),
  AffiliateEarning: require('./AffiliateEarning.model'),
  StoreDailyStat: stats.StoreDailyStat,
  StoreVisit: stats.StoreVisit,
  AffiliateClick: stats.AffiliateClick,
};
