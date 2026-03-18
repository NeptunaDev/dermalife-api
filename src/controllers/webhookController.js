const orderService = require('../services/orderService');
const logger = require('../services/logger');

async function handleOrderCompleted(req, res) {
  logger.section('Webhook orden completada recibido');
  logger.stepInfo('Request POST /webhook/order-completed recibido');

  try {
    const bodyStr = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    const payload = JSON.parse(bodyStr);
    logger.payload('Payload crudo de Shopify', payload);

    const result = await orderService.processOrder(req.body);

    logger.section('PROCESO COMPLETADO');
    logger.stepOk('Orden procesada y enviada a API externa');

    return res.status(200).json(result);
  } catch (error) {
    logger.section('ERROR EN PROCESAMIENTO');
    logger.stepErr(error.message);
    // Responder 200 para que Shopify no reintente infinitamente
    if (!res.headersSent) {
      return res.status(200).json({ ok: false, error: error.message });
    }
    return;
  }
}

module.exports = {
  handleOrderCompleted,
};
