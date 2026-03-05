const config = require('../config');
const { validatePayload } = require('../schemas/orderSchema');

function buildPayload(order) {
  return {
    orden_id: order.id,
    orden_numero: order.order_number,
    fecha: order.created_at,
    total: order.total_price,
    subtotal: order.subtotal_price,
    moneda: order.currency,
    estado_pago: order.financial_status,
    estado_envio: order.fulfillment_status,

    cliente: {
      id: order.customer?.id,
      nombre: `${order.customer?.first_name || ''} ${order.customer?.last_name || ''}`.trim(),
      email: order.customer?.email,
      telefono: order.customer?.phone,
    },

    envio: {
      nombre: order.shipping_address?.name,
      direccion: order.shipping_address?.address1,
      ciudad: order.shipping_address?.city,
      pais: order.shipping_address?.country,
    },

    productos: (order.line_items || []).map((item) => ({
      producto_id: item.product_id,
      variante_id: item.variant_id,
      nombre: item.name,
      sku: item.sku,
      cantidad: item.quantity,
      precio_unit: item.price,
      total: (parseFloat(item.price) * item.quantity).toFixed(2),
    })),

    descuentos: order.discount_codes?.map((d) => ({
      codigo: d.code,
      valor: d.amount,
      tipo: d.type,
    })),
  };
}

async function forwardToExternalApi(payload) {
  const { url, token } = config.apiExterna;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API externa error ${response.status}: ${text}`);
  }

  return response;
}

async function processOrder(rawBody) {
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const order = JSON.parse(bodyStr);
  const payload = buildPayload(order);

  const { error } = validatePayload(payload);
  if (error) {
    throw new Error(`Validación fallida: ${error.message}`);
  }

  await forwardToExternalApi(payload);
  return payload;
}

module.exports = {
  buildPayload,
  processOrder,
  forwardToExternalApi,
};
