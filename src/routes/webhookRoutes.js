const express = require('express');
const webhookController = require('../controllers/webhookController');
const { verifyShopifyHmac } = require('../middlewares/shopifyHmac');

const router = express.Router();

router.post(
  '/order-completed',
  express.raw({ type: 'application/json' }),
  // verifyShopifyHmac,
  webhookController.handleOrderCompleted
);

module.exports = router;
