const axios = require('axios');
const config = require('../config');
const logger = require('./logger');
const { getAuthHeaders, invalidateToken } = require('./hgiAuthService');

const EMPRESA = 1;
const COMPANIA = 1;
const CODIGO_TRANSACCION = 'FAC';
const CODIGO_VENDEDOR = '84';
const CODIGO_BODEGA = '5';

const base = (config.hgi.baseUrl || '').replace(/\/$/, '');

async function crearCabecera(ordenShopify, numeroIdentificacionCliente) {
  const headers = await getAuthHeaders();
  const email = ordenShopify.contact_email || ordenShopify.customer?.email || '';
  const body = [
    {
      Empresa: EMPRESA,
      Compania: COMPANIA,
      CodigoTransaccion: CODIGO_TRANSACCION,
      NumeroDocumento: `SHOP-${ordenShopify.id}`,
      Fecha: ordenShopify.created_at,
      NumeroIdentificacionTercero: numeroIdentificacionCliente,
      CodigoVendedor: CODIGO_VENDEDOR,
      CodigoBodega: CODIGO_BODEGA,
      ValorTotal: ordenShopify.total_price,
      Observaciones: `Orden Shopify #${ordenShopify.order_number} - ${email}`,
    },
  ];
  const { data, status } = await axios.post(`${base}/Api/Documentos/Crear`, body, {
    headers,
    validateStatus: () => true,
  });
  return { data, status };
}

async function crearDetalle(ordenShopify, codigoDocumento) {
  const headers = await getAuthHeaders();
  const items = (ordenShopify.line_items || []).filter((item) => {
    if (!item.sku || String(item.sku).trim() === '') {
      logger.stepInfo(`HGI: item sin SKU omitido (puede ser envío): ${item.name || item.title}`);
      return false;
    }
    return true;
  });
  const body = items.map((item) => ({
    Empresa: EMPRESA,
    Compania: COMPANIA,
    CodigoTransaccion: CODIGO_TRANSACCION,
    CodigoDocumento: codigoDocumento,
    CodigoProducto: item.sku,
    Cantidad: item.quantity,
    PrecioUnitario: item.price,
    Descuento: 0,
    CodigoBodega: CODIGO_BODEGA,
  }));
  if (body.length === 0) {
    logger.stepInfo('HGI: no hay ítems con SKU para crear detalle');
    return { data: null, status: 200 };
  }
  const { data, status } = await axios.post(`${base}/Api/Documentos/CrearDetalle`, body, {
    headers,
    validateStatus: () => true,
  });
  return { data, status };
}

function extraerCodigoDocumento(respuestaCrear) {
  const d = respuestaCrear?.data;
  if (d == null) return null;
  if (typeof d === 'number') return d;
  if (typeof d.CodigoDocumento !== 'undefined') return d.CodigoDocumento;
  if (typeof d.NumeroDocumento !== 'undefined') return d.NumeroDocumento;
  if (Array.isArray(d) && d.length > 0) {
    const first = d[0];
    return first?.CodigoDocumento ?? first?.NumeroDocumento ?? first;
  }
  return d.CodigoDocumento ?? d.NumeroDocumento ?? null;
}

async function crearFacturaEnHGI(ordenShopify, numeroIdentificacionCliente, retry = false) {
  const { data: dataCab, status: statusCab } = await crearCabecera(
    ordenShopify,
    numeroIdentificacionCliente
  );
  if (statusCab === 401) {
    if (retry) {
      logger.stepErr('HGI Documentos: 401 tras reintento');
      throw new Error('HGI: no autorizado');
    }
    invalidateToken();
    logger.stepInfo('HGI Documentos: 401, invalidando token y reintentando...');
    return crearFacturaEnHGI(ordenShopify, numeroIdentificacionCliente, true);
  }
  if (statusCab !== 200) {
    const msg = dataCab?.message || dataCab?.Message || JSON.stringify(dataCab);
    throw new Error(`HGI Crear cabecera: ${statusCab} - ${msg}`);
  }
  const codigoDocumento = extraerCodigoDocumento({ data: dataCab });
  if (codigoDocumento == null) {
    throw new Error('HGI: no se obtuvo CodigoDocumento de la respuesta');
  }
  logger.stepOk(`HGI: documento FAC creado: ${codigoDocumento}`);

  const { status: statusDet } = await crearDetalle(ordenShopify, codigoDocumento);
  if (statusDet === 401) {
    if (retry) {
      logger.stepErr('HGI Documentos detalle: 401 tras reintento');
      throw new Error('HGI: no autorizado');
    }
    invalidateToken();
    logger.stepInfo('HGI Documentos detalle: 401, invalidando token y reintentando...');
    return crearFacturaEnHGI(ordenShopify, numeroIdentificacionCliente, true);
  }
  if (statusDet !== 200) {
    logger.stepErr(`HGI CrearDetalle respondió ${statusDet}`);
    throw new Error(`HGI CrearDetalle: ${statusDet}`);
  }
  logger.stepOk('HGI: factura (cabecera + detalle) creada correctamente');
}

module.exports = {
  crearFacturaEnHGI,
};
