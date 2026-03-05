const express = require('express');
const webhookController = require('../controllers/webhookController');
const { verifyShopifyHmac } = require('../middlewares/shopifyHmac');

const router = express.Router();

router.post(
  '/order-created',
  express.raw({ type: 'application/json' }),
  verifyShopifyHmac,
  webhookController.handleOrderCreated
);

module.exports = router;
