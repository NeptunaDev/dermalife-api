const crypto = require('crypto');
const config = require('../config');
const logger = require('../services/logger');

/**
 * Middleware que verifica la firma HMAC-SHA256 de Shopify.
 * Debe usarse con express.raw({ type: 'application/json' }) para preservar el body.
 */
function verifyShopifyHmac(req, res, next) {
  logger.stepInfo('Iniciando verificación HMAC de Shopify...');
  const hmac = req.headers['x-shopify-hmac-sha256'];

  if (!hmac || !config.shopify.webhookSecret) {
    logger.stepErr('Falta header x-shopify-hmac-sha256 o SHOPIFY_WEBHOOK_SECRET en .env');
    return res.status(401).send('Unauthorized');
  }

  logger.stepInfo('Calculando hash con secret configurado...');
  const hash = crypto
    .createHmac('sha256', config.shopify.webhookSecret)
    .update(req.body)
    .digest('base64');

  if (hash !== hmac) {
    logger.stepErr('Firma HMAC inválida - hash no coincide');
    return res.status(401).send('Unauthorized');
  }

  logger.stepOk('Firma HMAC verificada correctamente');
  next();
}

module.exports = { verifyShopifyHmac };
