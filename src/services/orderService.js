const config = require('../config');
const { validatePayload } = require('../schemas/orderSchema');
const logger = require('./logger');
const { extraerClienteDeShopify } = require('../mappers/shopifyToHgi');
const { garantizarTercero } = require('./hgiTerceroService');
const { crearFacturaEnHGI } = require('./hgiDocumentService');

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

  logger.stepInfo(`Enviando a API externa: ${url}`);
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
    logger.stepErr(`API externa respondió ${response.status}: ${text}`);
    throw new Error(`API externa error ${response.status}: ${text}`);
  }

  logger.stepOk(`API externa respondió ${response.status} OK`);
  return response;
}

async function processOrder(rawBody) {
  logger.stepInfo('Convirtiendo body raw a JSON...');
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const order = JSON.parse(bodyStr);
  logger.stepOk('Body parseado correctamente');

  logger.stepInfo('Construyendo payload para API externa...');
  const payload = buildPayload(order);
  logger.payload('Payload transformado', payload);
  logger.stepOk(`Payload listo: orden #${payload.orden_numero}, ${payload.productos?.length || 0} producto(s)`);

  logger.stepInfo('Validando estructura con schema Joi...');
  const { error } = validatePayload(payload);
  if (error) {
    logger.stepErr(`Validación fallida: ${error.message}`);
    throw new Error(`Validación fallida: ${error.message}`);
  }
  logger.stepOk('Validación pasada');

  await forwardToExternalApi(payload);

  // Facturación automática en HGI (no fallar el webhook si HGI falla)
  if (config.hgi?.baseUrl) {
    try {
      const datosCliente = extraerClienteDeShopify(order);
      await garantizarTercero(datosCliente);
      await crearFacturaEnHGI(order, datosCliente.numeroIdentificacion);
    } catch (hgiError) {
      logger.stepErr(`HGI facturación: ${hgiError.message}`);
    }
  }

  return payload;
}

module.exports = {
  buildPayload,
  processOrder,
  forwardToExternalApi,
};
