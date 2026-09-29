const logger = require("../services/logger");
const config = require("../config");

// Tasa de IVA por defecto (fracción, ej. 0.19 = 19%) cuando no se puede resolver
// la tarifa real del producto (CodigoTarifaIVA). Confirmado con FAC #18406 (SKU 22292,
// transacción 67 en modo "Precio Producto Fijo"): ValorTotal = ValorUnitario / (1+iva) y
// ValorDescuento = (ValorUnitario - precio_cobrado) / (1+iva); ambos en pesos SIN IVA,
// porque HGI arma el IVA aparte a partir de la base gravable (ValorTotal - ValorDescuento).
// TODO: resolver la tarifa real por producto (CodigoTarifaIVA) en vez de usar un único
// valor por defecto para todos los SKU, una vez se confirme el endpoint REST de tarifas.
const IVA_RATE_DEFAULT = Number(config.hgi?.ivaRateDefault ?? 0.19);

function redondear2(valor) {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function redondear4(valor) {
  return Math.round((valor + Number.EPSILON) * 10000) / 10000;
}

function formatoFecha(createdAt) {
  const d = new Date(createdAt);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}:${s}`;
}

/**
 * Mapea el objeto order del webhook de Shopify a terceroData, docData e items para HGI.
 * @param {object} order
 * @param {Map<string, number|null>} [compareAtPriceMap] variant_id (string) -> compare_at_price,
 *   obtenido de Shopify Admin API (el webhook no lo trae). Ver shopifyAdminService.
 */
function mapearOrdenShopifyParaHGI(order, compareAtPriceMap = new Map()) {
  const customer = order.customer || {};
  const shipping = order.shipping_address || {};
  const billing = order.billing_address || {};

  const numeroIdentificacion = (
    order.shipping_address?.company || // campo "Número de Identificación" del checkout (entrega)
    order.billing_address?.company || // fallback billing
    String(customer.id ?? "")
  ).trim();

  const terceroData = {
    numeroIdentificacion,
    nombre:
      [customer.first_name, customer.last_name]
        .filter(Boolean)
        .join(" ")
        .trim() || "Cliente Shopify",
    direccion: shipping.address1 ?? "",
    telefono: shipping.phone ?? billing.phone ?? "",
    email: order.contact_email ?? "",
    ciudad: shipping.city ?? "",
  };

  const createdAt = order.created_at ? new Date(order.created_at) : new Date();
  const ano = createdAt.getFullYear();
  const periodo = createdAt.getMonth() + 1;

  const docData = {
    numeroDocumento: "SHOP-" + order.order_number,
    fecha: formatoFecha(order.created_at),
    ano,
    periodo,
    total: parseFloat(order.total_price) || 0,
    observaciones:
      "Orden Shopify #" +
      order.order_number +
      " - " +
      (order.contact_email ?? ""),
    numeroIdentificacion: terceroData.numeroIdentificacion,
    payment_gateway_names: order.payment_gateway_names ?? [],
  };

  const items = [];
  for (const item of order.line_items || []) {
    const sku = item.sku != null ? String(item.sku).trim() : "";
    if (sku === "") {
      logger.stepInfo(
        `Shopify→HGI: ítem sin SKU omitido: ${item.title || item.name || "(sin nombre)"}`,
      );
      continue;
    }
    const cantidad = item.quantity;
    const precioVentaUnitario = parseFloat(item.price) || 0;
    // total_discount = descuento por código promocional/automático aplicado a esta
    // línea (adicional al precio ya rebajado en la variante), calculado por Shopify en pesos.
    const totalDescuentoCodigo = redondear2(parseFloat(item.total_discount) || 0);

    // compare_at_price no viene en el webhook de Shopify; se resuelve aparte
    // (Shopify Admin API, por variant_id) y se pasa en compareAtPriceMap.
    const variantId = item.variant_id != null ? String(item.variant_id) : null;
    const compareAtPriceRaw = variantId ? compareAtPriceMap.get(variantId) : null;
    const compareAtPrice =
      typeof compareAtPriceRaw === "number" && Number.isFinite(compareAtPriceRaw)
        ? compareAtPriceRaw
        : null;

    // Precio de lista para el desglose: solo si compare_at_price existe y es mayor
    // al precio de venta (si no, no hay "descuento de lista" que mostrar y se usa price).
    const hayPrecioDeLista = compareAtPrice != null && compareAtPrice > precioVentaUnitario;
    // valorUnitario es SIEMPRE por unidad, con IVA incluido (así lo maneja el campo
    // ValorUnitario de HGI: precio de catálogo/lista, no el neto pre-IVA).
    const valorUnitario = hayPrecioDeLista ? compareAtPrice : precioVentaUnitario;

    const ivaRate = IVA_RATE_DEFAULT;
    const factorIva = 1 + ivaRate;

    // ValorTotal en HGI = bruto de la línea (unitario x cantidad) ANTES de descuento y
    // SIN IVA. HGI arma el IVA aparte a partir de (ValorTotal - ValorDescuento).
    const valorTotal = redondear2((valorUnitario * cantidad) / factorIva);

    // Lo realmente cobrado al cliente, con IVA incluido (precio de venta x cantidad,
    // menos código de descuento si aplica). Se conserva sin deflactar para logging/reconciliación.
    const valorNetoCobradoConIva = redondear2(
      precioVentaUnitario * cantidad - totalDescuentoCodigo,
    );
    const valorNetoCobradoSinIva = redondear2(valorNetoCobradoConIva / factorIva);

    // ValorDescuento va SIN IVA (deflactado), igual que ValorTotal: HGI resta este valor
    // de ValorTotal para obtener la base gravable, y sobre esa base calcula el IVA.
    const valorDescuento = redondear2(valorTotal - valorNetoCobradoSinIva);

    // HGI espera PorcentajeDescuento como fracción (0-1), no como porcentaje (0-100):
    // multiplica x100 él mismo al mostrar "PDes%" en la factura. Confirmado con FAC #18577
    // (SKU 33038): mandamos 98.21 y HGI mostró "9.821%" (98.21 x 100 de más). Esta razón
    // es la misma con o sin IVA (se cancela en la división), confirmado con FAC #18406.
    const porcentajeDescuentoVisible =
      valorTotal > 0 ? redondear2((valorDescuento / valorTotal) * 100) : 0;
    const porcentajeDescuento = redondear4(porcentajeDescuentoVisible / 100);

    items.push({
      sku,
      cantidad,
      nombre: item.title ?? item.name ?? "",
      valorUnitario,
      valorTotal,
      valorDescuento,
      porcentajeDescuento,
      // Solo para logging/reconciliación local; no se envía a HGI.
      valorNetoCobradoConIva,
    });
  }

  return { terceroData, docData, items };
}

module.exports = {
  mapearOrdenShopifyParaHGI,
};
