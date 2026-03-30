const express = require('express');
const webhookRoutes = require('./routes/webhookRoutes');
const ordersRoutes = require('./routes/ordersRoutes');
const logger = require('./services/logger');
const hgiCacheService = require('./services/hgiCacheService');

const app = express();

// Webhook routes must run BEFORE express.json() to receive raw body for HMAC verification
app.use('/webhook', webhookRoutes);
app.use('/orders', ordersRoutes);

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

async function init() {
  await hgiCacheService.inicializarCache();
}

module.exports = app;
module.exports.init = init;
