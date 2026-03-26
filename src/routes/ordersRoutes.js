const express = require('express');
const ordersController = require('../controllers/ordersController');

const router = express.Router();

// GET /orders?estado=pendiente|creado
router.get('/', ordersController.getOrders);

module.exports = router;

