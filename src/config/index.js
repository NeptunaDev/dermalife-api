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
  hgi: {
    baseUrl: process.env.HGI_BASE_URL || '',
    usuario: process.env.HGI_USUARIO || '',
    clave: process.env.HGI_CLAVE || '',
    /** Solo fuera de production: JWT fijo para desarrollo (sin refresh automático). */
    manualToken: process.env.HGI_MANUAL_TOKEN || '',
    codCompania: process.env.HGI_COD_COMPANIA || '1',
    codEmpresa: process.env.HGI_COD_EMPRESA || '1',
    tercero: {
      codigoTipoTercero: process.env.HGI_CODIGO_TIPO_TERCERO || '10',
      codigoVendedor: process.env.HGI_CODIGO_VENDEDOR || '84',
      codigoSucursal: process.env.HGI_CODIGO_SUCURSAL || '1',
      codigoCausaRetiro: process.env.HGI_CODIGO_CAUSA_RETIRO || '0',
      codigoCiudadDefault: process.env.HGI_CODIGO_CIUDAD_DEFAULT || '04',
    },
  },
};
