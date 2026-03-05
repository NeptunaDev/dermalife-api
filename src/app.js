const express = require('express');
const webhookRoutes = require('./routes/webhookRoutes');

const app = express();

app.use(express.json());

app.use('/webhook', webhookRoutes);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

module.exports = app;
