const crypto = require('crypto');
const config = require('../config');

/**
 * Middleware que verifica la firma HMAC-SHA256 de Shopify.
 * Debe usarse con express.raw({ type: 'application/json' }) para preservar el body.
 */
function verifyShopifyHmac(req, res, next) {
  const hmac = req.headers['x-shopify-hmac-sha256'];

  if (!hmac || !config.shopify.webhookSecret) {
    return res.status(401).send('Unauthorized');
  }

  const hash = crypto
    .createHmac('sha256', config.shopify.webhookSecret)
    .update(req.body)
    .digest('base64');

  if (hash !== hmac) {
    return res.status(401).send('Unauthorized');
  }

  next();
}

module.exports = { verifyShopifyHmac };
