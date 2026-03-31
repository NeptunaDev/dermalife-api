const fs = require("fs");
const path = require("path");
const config = require("../config");
const { hgiRequest } = require("./hgiAuthService");

const base = (config.hgi?.baseUrl || "").replace(/\/$/, "");
const PRODUCTS_JSON_PATH = path.resolve(__dirname, "../../products.json");

/** No se suman ni se muestran en `result` / `inventory` (p. ej. bodegas 0, 2, 4, 7). */
const BODEGAS_EXCLUIDAS = new Set(["0", "2", "4", "7"]);

let cachedProductosPorCodigo = null;
let cachedProductosMtime = null;

function sortKeysBodega(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb) && a === String(na) && b === String(nb)) {
    return na - nb;
  }
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

function sortKeysPrecio(keys) {
  return [...keys].sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ""), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ""), 10) || 0;
    return na - nb;
  });
}

/**
 * Mapa Codigo → producto desde products.json (cache por mtime).
 * @returns {Record<string, object>}
 */
function obtenerProductosPorCodigoDesdeJson() {
  if (!fs.existsSync(PRODUCTS_JSON_PATH)) {
    return {};
  }
  const stat = fs.statSync(PRODUCTS_JSON_PATH);
  if (
    cachedProductosPorCodigo != null &&
    cachedProductosMtime === stat.mtimeMs
  ) {
    return cachedProductosPorCodigo;
  }
  const raw = fs.readFileSync(PRODUCTS_JSON_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    cachedProductosPorCodigo = {};
    cachedProductosMtime = stat.mtimeMs;
    return cachedProductosPorCodigo;
  }
  cachedProductosPorCodigo = parsed;
  cachedProductosMtime = stat.mtimeMs;
  return cachedProductosPorCodigo;
}

/**
 * Precio1…PrecioN con valor numérico ≠ 0.
 * @param {object | null | undefined} producto
 */
function extraerPreciosNoCero(producto) {
  if (!producto || typeof producto !== "object") return {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(producto)) {
    if (!/^Precio\d+$/i.test(k)) continue;
    const num = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
    if (Number.isFinite(num) && num !== 0) {
      out[k] = num;
    }
  }
  return out;
}

/**
 * Tras bodegas y total: Descripcion y solo precios ≠ 0.
 * @param {Record<string, Record<string, number>>} grouped  inventario agrupado (incluye total 0)
 * @param {Record<string, object>} productosPorCodigo
 */
function enriquecerInventarioConProductos(grouped, productosPorCodigo) {
  const productos = productosPorCodigo || {};
  /** @type {Record<string, Record<string, string | number>>} */
  const out = {};

  for (const [cod, row] of Object.entries(grouped)) {
    if (!row || typeof row !== "object") continue;
    const prod = productos[cod];
    const bodegaKeys = Object.keys(row).filter((k) => k !== "total");
    bodegaKeys.sort(sortKeysBodega);

    /** @type {Record<string, string | number>} */
    const next = {};
    for (const b of bodegaKeys) {
      next[b] = row[b];
    }
    next.total = row.total;
    next.Descripcion =
      prod != null ? String(prod.Descripcion ?? prod.descripcion ?? "") : "";

    const precios = extraerPreciosNoCero(prod || {});
    for (const pk of sortKeysPrecio(Object.keys(precios))) {
      next[pk] = precios[pk];
    }
    out[cod] = next;
  }
  return out;
}

const DEFAULT_PARAMS = {
  codigo_producto: "",
  movil: "",
  ecommerce: "",
  codigo_bodega: "",
  codigo_lote: "",
  codigo_talla: "",
  codigo_color: "",
  sku: "",
  ean: "",
};

/**
 * GET /Api/Inventario/Obtener — parámetros como en el cliente HGI.
 * @param {Record<string, string>} query  querystring (req.query)
 */
async function obtenerInventario(query = {}) {
  if (!base) {
    throw new Error("HGI: HGI_BASE_URL no configurado");
  }

  const url = `${base}/Api/Inventario/Obtener`;
  const params = { ...DEFAULT_PARAMS, ...query };

  const { data } = await hgiRequest({
    method: "get",
    url,
    params,
  });

  return data;
}

/**
 * Agrupa filas de inventario por CodigoProducto → por CodigoBodega (Cantidad sumada)
 * y añade total por producto.
 * @param {unknown[]} rows  respuesta cruda de /Api/Inventario/Obtener
 * @returns {Record<string, Record<string, number>>}  { [codigoProducto]: { [codigoBodega]: cantidad, total } }
 */
function agruparInventarioPorProductoYBodega(rows) {
  if (!Array.isArray(rows)) {
    throw new Error("HGI inventario: la respuesta no es un array");
  }

  /** @type {Map<string, Map<string, number>>} */
  const porProducto = new Map();

  for (const row of rows) {
    const cod = String(row.CodigoProducto ?? "").trim();
    const bod = String(row.CodigoBodega ?? "").trim();
    if (BODEGAS_EXCLUIDAS.has(bod)) continue;

    const rawQty = row.Cantidad;
    const qty =
      typeof rawQty === "number"
        ? rawQty
        : parseFloat(String(rawQty ?? "").replace(",", "."));
    if (!Number.isFinite(qty)) continue;

    if (!porProducto.has(cod)) porProducto.set(cod, new Map());
    const porBodega = porProducto.get(cod);
    porBodega.set(bod, (porBodega.get(bod) ?? 0) + qty);
  }

  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  const codigos = [...porProducto.keys()].sort(sortKeysBodega);

  for (const cod of codigos) {
    const porBodega = porProducto.get(cod);
    const bodegas = [...porBodega.keys()].sort(sortKeysBodega);
    let total = 0;
    /** @type {Record<string, number>} */
    const obj = {};
    for (const b of bodegas) {
      const c = porBodega.get(b) ?? 0;
      obj[b] = c;
      total += c;
    }
    obj.total = total;
    out[cod] = obj;
  }

  return out;
}

module.exports = {
  obtenerInventario,
  agruparInventarioPorProductoYBodega,
  obtenerProductosPorCodigoDesdeJson,
  enriquecerInventarioConProductos,
};
