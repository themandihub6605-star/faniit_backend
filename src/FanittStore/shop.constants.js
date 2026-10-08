// Fanitt Store — physical products (shop): every enum in one place.
// Models, services, controllers and validators all read from here.

const SHOP_CATEGORIES = Object.freeze(['fashion', 'accessories', 'beauty', 'home', 'electronics', 'books', 'art', 'fitness', 'food', 'merch', 'other']);

const SHOP_PRODUCT_STATUS = Object.freeze({
  DRAFT: 'draft',
  PUBLISHED: 'published',
  UNPUBLISHED: 'unpublished',
  REMOVED: 'removed', // taken down by admin
});

// awaiting_payment (online only) → placed → confirmed → shipped → delivered
// placed / confirmed → cancelled;  awaiting_payment → payment_failed (30 min)
const SHOP_ORDER_STATUS = Object.freeze({
  AWAITING_PAYMENT: 'awaiting_payment',
  PLACED: 'placed',
  CONFIRMED: 'confirmed',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  PAYMENT_FAILED: 'payment_failed',
});

const SHOP_PAYMENT_METHOD = Object.freeze({ COD: 'cod', ONLINE: 'online' });
const SHOP_PAYMENT_STATUS = Object.freeze({ PENDING: 'pending', PAID: 'paid', REFUNDED: 'refunded', FAILED: 'failed' });

module.exports = { SHOP_CATEGORIES, SHOP_PRODUCT_STATUS, SHOP_ORDER_STATUS, SHOP_PAYMENT_METHOD, SHOP_PAYMENT_STATUS };