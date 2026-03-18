const axios = require('axios');
const config = require('../config');
const logger = require('./logger');
const { getToken } = require('./hgiAuthService');

const base = (config.hgi?.baseUrl || '').replace(/\/$/, '');

const ciudadesMap = new Map();
const productosMap = new Map();

function normalizarNombreCiudad(nombre) {
  return nombre
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

async function cargarCiudades() {
  if (!base) return;
  const token = await getToken();
  const url = `${base}/Api/Ciudades/Obtener`;
  logger.stepInfo('HGI Cache: cargando ciudades...');
  const { data } = await axios.get(url, {
    params: { codigo: '*' },
    headers: { Authorization: `Bearer ${token}` },
  });
  // Mostrar estructura real para ajustar el parseo (primeros 300 chars)
  const preview = (() => {
    try {
      return JSON.stringify(data).substring(0, 300);
    } catch {
      return String(data).substring(0, 300);
    }
  })();
  logger.stepInfo('HGI Cache: estructura respuesta ciudades: ' + preview);

  // Algunas versiones devuelven array directo y otras envuelven en propiedad
  let lista = [];
  if (Array.isArray(data)) {
    lista = data;
  } else if (data && typeof data === 'object') {
    const posibleArray =
      data.Ciudades ||
      data.ciudades ||
      data.Data ||
      data.data ||
      data.Resultado ||
      data.resultado ||
      data.Items ||
      data.items;
    if (Array.isArray(posibleArray)) {
      lista = posibleArray;
    } else {
      // fallback: primer array encontrado en propiedades
      const firstArray = Object.values(data).find((v) => Array.isArray(v));
      if (Array.isArray(firstArray)) lista = firstArray;
    }
  }
  ciudadesMap.clear();
  for (const item of lista) {
    const nombre = item.Nombre ?? item.nombre ?? '';
    const codigo = item.Codigo ?? item.codigo ?? '';
    if (nombre && codigo) {
      const clave = normalizarNombreCiudad(nombre);
      ciudadesMap.set(clave, String(codigo));
    }
  }
  logger.stepOk(`HGI Cache: ${ciudadesMap.size} ciudades cargadas`);
}

async function cargarProductos() {
  if (!base) return;
  const token = await getToken();
  const url = `${base}/Api/Productos/ObtenerProductos`;
  logger.stepInfo('HGI Cache: cargando productos...');
  const { data } = await axios.get(url, {
    params: {
      codigo_producto: '*',
      movil: '*',
      ecommerce: '*',
      kardex: '*',
      incluir_foto: false,
      estado: '*',
    },
    headers: { Authorization: `Bearer ${token}` },
  });
  const lista = Array.isArray(data) ? data : [];
  productosMap.clear();
  for (const item of lista) {
    const codigo = item.Codigo ?? item.codigo ?? '';
    const unidad = item.CodigoUnidad ?? item.codigoUnidad ?? 'UN';
    if (codigo) {
      productosMap.set(String(codigo), String(unidad));
    }
  }
  logger.stepOk(`HGI Cache: ${productosMap.size} productos cargados`);
}

async function inicializarCache() {
  if (!base) {
    logger.stepInfo('HGI Cache: HGI_BASE_URL no configurado, omitiendo cache');
    return;
  }
  await cargarCiudades();
  await cargarProductos();
}

function obtenerCodigoCiudad(nombreCiudad) {
  if (nombreCiudad == null || String(nombreCiudad).trim() === '') {
    throw new Error('Ciudad no encontrada en HGI: (vacío)');
  }
  const clave = normalizarNombreCiudad(String(nombreCiudad));
  const codigo = ciudadesMap.get(clave);
  if (codigo == null) {
    throw new Error(`Ciudad no encontrada en HGI: ${nombreCiudad}`);
  }
  return codigo;
}

function obtenerUnidadProducto(sku) {
  const codigo = sku != null ? String(sku).trim() : '';
  const unidad = productosMap.get(codigo);
  if (unidad == null) {
    logger.stepInfo(`HGI Cache: producto no encontrado, usando UN como fallback: ${codigo || '(sin SKU)'}`);
    return 'UN';
  }
  return unidad;
}

module.exports = {
  inicializarCache,
  obtenerCodigoCiudad,
  obtenerUnidadProducto,
};
