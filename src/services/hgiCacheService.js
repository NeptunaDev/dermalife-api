const config = require('../config');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { hgiRequest } = require('./hgiAuthService');
const Fuse = require('fuse.js');

const base = (config.hgi?.baseUrl || '').replace(/\/$/, '');
const CIUDAD_JSON_PATH = path.resolve(__dirname, '../../data/ciudad/ciudad.json');
const PRODUCTS_JSON_PATH = path.resolve(__dirname, '../../products.json');

const ciudadesMap = new Map();
const productosMap = new Map();
let fuseCiudades = null;
const cacheCodigoCiudad = new Map(); // cache de O(1) por nombre normalizado

function normalizarNombreCiudad(nombre) {
  // Quitamos tildes (á->a, Á->A) y luego pasamos a mayusculas
  return String(nombre)
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function construirFuseCiudades() {
  // índice para búsquedas aproximadas (typos)
  const items = Array.from(ciudadesMap.keys());
  fuseCiudades = new Fuse(items, { threshold: 0.4, ignoreLocation: true });
}

async function cargarCiudades() {
  // Preferimos ciudad.json (sin endpoint)
  try {
    const raw = fs.readFileSync(CIUDAD_JSON_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      ciudadesMap.clear();
      for (const [nombre, codigo] of Object.entries(data)) {
        if (!nombre || codigo == null) continue;
        const clave = normalizarNombreCiudad(nombre);
        ciudadesMap.set(clave, String(codigo));
      }
      logger.stepOk(`HGI Cache: ${ciudadesMap.size} ciudades cargadas desde ciudad.json`);
      construirFuseCiudades();
      cacheCodigoCiudad.clear();
      return;
    }
  } catch (err) {
    logger.stepErr(`HGI Cache: no se pudo leer ciudad.json; usando endpoint HGI. ${err.message}`);
  }

  // Fallback: endpoint HGI (si ciudad.json no existe o tiene estructura inválida)
  if (!base) return;
  const url = `${base}/Api/Ciudades/Obtener`;
  logger.stepInfo('HGI Cache: cargando ciudades desde endpoint...');
  const { data } = await hgiRequest({
    method: 'get',
    url,
    params: { codigo: '*' },
  });

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

  logger.stepOk(`HGI Cache: ${ciudadesMap.size} ciudades cargadas desde endpoint`);
  construirFuseCiudades();
  cacheCodigoCiudad.clear();
}

async function cargarProductos() {
  if (!base) return;
  const url = `${base}/Api/Productos/ObtenerProductos`;
  logger.stepInfo(`HGI Cache: cargando productos desde ${url} ...`);
  const { data } = await hgiRequest({
    method: 'get',
    url,
    params: {
      codigo_producto: '*',
      movil: '*',
      ecommerce: '*',
      kardex: '*',
      incluir_foto: false,
      estado: '*',
    },
  });
  const lista = Array.isArray(data) ? data : [];
  productosMap.clear();
  /** @type {Record<string, object>} */
  const productosPorCodigo = {};
  for (const item of lista) {
    const codigo = item.Codigo ?? item.codigo ?? '';
    const unidad = item.CodigoUnidad ?? item.codigoUnidad ?? 'UN';
    if (codigo) {
      const key = String(codigo);
      productosMap.set(key, String(unidad));
      productosPorCodigo[key] = item;
    }
  }
  try {
    fs.writeFileSync(
      PRODUCTS_JSON_PATH,
      JSON.stringify(productosPorCodigo, null, 2),
      'utf8',
    );
    logger.stepInfo(`HGI Cache: products.json escrito en ${PRODUCTS_JSON_PATH}`);
  } catch (err) {
    logger.stepErr(`HGI Cache: no se pudo escribir products.json: ${err.message}`);
    throw err;
  }
  if (Object.keys(productosPorCodigo).length === 0) {
    throw new Error('HGI Cache: products.json quedó vacío');
  }
  logger.stepOk(
    `HGI Cache: ${productosMap.size} productos cargados; products.json actualizado`,
  );
}

async function inicializarCache() {
  // Ciudades: preferimos cargar desde `ciudad.json`, no depende del endpoint HGI.
  await cargarCiudades();

  // Productos: siguen dependiendo del endpoint HGI.
  if (!base) {
    throw new Error('HGI Cache: HGI_BASE_URL no configurado; no se puede cargar products.json');
  }

  await cargarProductos();
}

function obtenerCodigoCiudad(nombreCiudad) {
  if (nombreCiudad == null || String(nombreCiudad).trim() === '') {
    throw new Error('Ciudad no encontrada en HGI: (vacío)');
  }
  const clave = normalizarNombreCiudad(String(nombreCiudad));

  // O(1): evita repetir fuzzy search y lecturas del mapa.
  if (cacheCodigoCiudad.has(clave)) {
    const cached = cacheCodigoCiudad.get(clave);
    if (cached != null) return cached;
    throw new Error(`Ciudad no encontrada en HGI: ${nombreCiudad}`);
  }

  const codigo = ciudadesMap.get(clave);
  if (codigo != null) {
    cacheCodigoCiudad.set(clave, codigo);
    return codigo;
  }

  // Fuzzy match local para corregir typos o variaciones menores.
  let codigoFuzzy = null;
  if (fuseCiudades) {
    const res = fuseCiudades.search(clave);
    const mejorKey = res?.[0]?.item ?? null;
    if (mejorKey) {
      const candidato = ciudadesMap.get(mejorKey);
      if (candidato != null) codigoFuzzy = candidato;
    }
  }

  cacheCodigoCiudad.set(clave, codigoFuzzy); // puede ser null (para no reintentar)
  if (codigoFuzzy != null) return codigoFuzzy;
  throw new Error(`Ciudad no encontrada en HGI: ${nombreCiudad}`);
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
