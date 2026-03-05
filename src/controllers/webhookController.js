const orderService = require('../services/orderService');

async function handleOrderCreated(req, res) {
  try {
    await orderService.processOrder(req.body);
  } catch (error) {
    console.error('Error procesando orden:', error.message);
    // Responder 200 para que Shopify no reintente infinitamente
  }

  res.status(200).send('OK');
}

module.exports = {
  handleOrderCreated,
};
