const config = require('../config');
const { validatePayload } = require('../schemas/orderSchema');
const logger = require('./logger');
const { mapearOrdenShopifyParaHGI } = require('../mappers/shopifyToHgi');
const { getToken } = require('./hgiAuthService');
const hgiCacheService = require('./hgiCacheService');
const { crearOActualizarTercero } = require('./hgiTerceroService');
const { crearEncabezadoFAC, crearDetalleFAC } = require('./hgiDocumentService');

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

  const { terceroData, docData, items } = mapearOrdenShopifyParaHGI(order);
  logger.stepInfo(`Orden mapeada: tercero ${terceroData.numeroIdentificacion}, ${items.length} ítem(s)`);

  if (items.length === 0) {
    logger.stepErr('No hay ítems con SKU para facturar en HGI');
    throw new Error('No hay ítems con SKU para facturar en HGI');
  }

  logger.stepInfo('Obteniendo token HGI...');
  const token = await getToken();

  logger.stepInfo('Obteniendo código ciudad desde caché...');
  const codigoCiudad = hgiCacheService.obtenerCodigoCiudad(terceroData.ciudad);
  terceroData.codigoCiudad = codigoCiudad;

  logger.stepInfo('Creando o actualizando tercero en HGI...');
  await crearOActualizarTercero(terceroData, token);

  logger.stepInfo('Creando encabezado FAC en HGI...');
  const numeroDoc = await crearEncabezadoFAC(docData, token);
  if (numeroDoc == null) {
    throw new Error('HGI: no se obtuvo número de documento del encabezado');
  }

  for (const item of items) {
    logger.stepInfo(`Creando detalle FAC para SKU ${item.sku}...`);
    await crearDetalleFAC(numeroDoc, item, terceroData.numeroIdentificacion, docData.fecha, token);
  }

  logger.stepOk(`FAC #${numeroDoc} creada en HGI para orden Shopify #${order.order_number}`);
  return {
    orden_numero: order.order_number,
    numeroDoc,
    terceroData,
    itemsCount: items.length,
  };
}

module.exports = {
  buildPayload,
  processOrder,
  forwardToExternalApi,
};
