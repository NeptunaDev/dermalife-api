require('dotenv').config();

module.exports = {
  port: process.env.PORT || 3000,
  shopify: {
    webhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
  },
  apiExterna: {
    url: process.env.API_EXTERNA_URL || 'https://tu-api-externa.com/ordenes',
    token: process.env.API_EXTERNA_TOKEN || '',
  },
};
