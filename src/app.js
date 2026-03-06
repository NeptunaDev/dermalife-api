const express = require('express');
const webhookRoutes = require('./routes/webhookRoutes');

const app = express();

// Webhook routes must run BEFORE express.json() to receive raw body for HMAC verification
app.use('/webhook', webhookRoutes);

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

module.exports = app;
