const logger = require("../services/logger");

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
 */
function mapearOrdenShopifyParaHGI(order) {
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
    items.push({
      sku,
      cantidad: item.quantity,
      nombre: item.title ?? item.name ?? "",
    });
  }

  return { terceroData, docData, items };
}

module.exports = {
  mapearOrdenShopifyParaHGI,
};
