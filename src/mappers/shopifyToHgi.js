const logger = require("../services/logger");

function redondear2(valor) {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function redondear4(valor) {
  return Math.round((valor + Number.EPSILON) * 10000) / 10000;
}

function separarPalabras(texto) {
  return String(texto ?? "").trim().split(/\s+/).filter(Boolean);
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

  // Nombres y apellidos por separado: HGI arma el "Nombre" del maestro a partir de
  // Apellido1/Apellido2/Nombre1/Nombre2; si solo se envía Nombre, el encabezado queda vacío.
  const primerosNombres =
    customer.first_name || billing.first_name || shipping.first_name || "";
  const apellidos =
    customer.last_name || billing.last_name || shipping.last_name || "";
  const [nombre1 = "", ...restoNombres] = separarPalabras(primerosNombres);
  const [apellido1 = "", ...restoApellidos] = separarPalabras(apellidos);
  const telefono =
    shipping.phone || billing.phone || customer.phone || order.phone || "";
  const email = order.contact_email || customer.email || order.email || "";

  const terceroData = {
    numeroIdentificacion,
    // Mismo orden que usa HGI para personas naturales: apellidos y luego nombres.
    nombre:
      [apellido1, ...restoApellidos, nombre1, ...restoNombres]
        .filter(Boolean)
        .join(" ") ||
      "Cliente Shopify",
    nombre1,
    nombre2: restoNombres.join(" "),
    apellido1,
    apellido2: restoApellidos.join(" "),
    direccion: shipping.address1 ?? "",
    direccionAlterna: shipping.address2 ?? "",
    telefono,
    celular: telefono,
    email,
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
    // valorUnitario por unidad, tal cual viene de Shopify (con IVA incluido). La
    // transacción 67 tiene IvaIncluido=1, así que HGI maneja el IVA internamente a
    // partir de estos valores sin que nosotros deflactemos nada.
    const valorUnitario = hayPrecioDeLista ? compareAtPrice : precioVentaUnitario;

    const valorBrutoLista = redondear2(valorUnitario * cantidad);
    // Lo realmente cobrado al cliente (precio de venta x cantidad, menos código de descuento si aplica).
    const valorNetoCobrado = redondear2(precioVentaUnitario * cantidad - totalDescuentoCodigo);
    const valorDescuento = redondear2(valorBrutoLista - valorNetoCobrado);
    // Transacción 67 en modo 0 (Sin Precio): HGI calcula Total = ValorTotal - ValorDescuento,
    // así que ValorTotal debe ser el precio de lista (bruto, antes de descuento), no lo neto cobrado.
    const valorTotal = valorBrutoLista;

    // HGI espera PorcentajeDescuento como fracción (0-1), no como porcentaje (0-100):
    // multiplica x100 él mismo al mostrar "PDes%" en la factura. Confirmado con FAC #18577
    // (SKU 33038): mandamos 98.21 y HGI mostró "9.821%" (98.21 x 100 de más).
    const porcentajeDescuentoVisible =
      valorBrutoLista > 0 ? redondear2((valorDescuento / valorBrutoLista) * 100) : 0;
    const porcentajeDescuento = redondear4(porcentajeDescuentoVisible / 100);

    items.push({
      sku,
      cantidad,
      nombre: item.title ?? item.name ?? "",
      valorUnitario,
      valorTotal,
      valorDescuento,
      porcentajeDescuento,
    });
  }

  return { terceroData, docData, items };
}

module.exports = {
  mapearOrdenShopifyParaHGI,
};
