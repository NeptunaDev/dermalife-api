const orderPersistenceService = require('../services/orderPersistenceService');

async function getOrders(req, res) {
  const { estado } = req.query;
  const orders = orderPersistenceService.getOrders({ estado });

  return res.status(200).json({
    count: orders.length,
    estado: estado ?? null,
    orders,
  });
}

module.exports = {
  getOrders,
};

