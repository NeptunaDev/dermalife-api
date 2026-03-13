/**
 * Extrae datos del cliente del payload del webhook de Shopify para HGI.
 * Cédula/NIT: billing_address.company → note_attributes (cedula/nit/identificacion) → fallback customer.id
 * Limpia identificación: solo números.
 */
function limpiarIdentificacion(val) {
  if (val == null || val === '') return '';
  const s = String(val).trim();
  const soloNumeros = s.replace(/\D/g, '');
  return soloNumeros || s;
}

function buscarIdentificacionEnNotas(orden) {
  const notes = orden.note_attributes || [];
  const keys = ['cedula', 'nit', 'identificacion', 'identificación', 'documento', 'ruc'];
  for (const attr of notes) {
    const name = (attr.name || attr.key || '').toLowerCase();
    if (keys.some((k) => name.includes(k))) {
      const v = attr.value ?? attr.val;
      if (v != null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return null;
}

function extraerClienteDeShopify(orden) {
  let numeroIdentificacion = null;
  if (orden.billing_address?.company && String(orden.billing_address.company).trim() !== '') {
    numeroIdentificacion = orden.billing_address.company.trim();
  }
  if (!numeroIdentificacion) {
    const deNotas = buscarIdentificacionEnNotas(orden);
    if (deNotas) numeroIdentificacion = deNotas;
  }
  if (!numeroIdentificacion && orden.customer?.id != null) {
    numeroIdentificacion = String(orden.customer.id);
  }
  numeroIdentificacion = limpiarIdentificacion(numeroIdentificacion || '0');

  const nombre =
    orden.billing_address?.name ||
    [orden.customer?.first_name, orden.customer?.last_name].filter(Boolean).join(' ') ||
    orden.shipping_address?.name ||
    orden.customer?.email ||
    'Cliente Shopify';

  const email = orden.contact_email || orden.customer?.email || '';

  const telefono =
    orden.billing_address?.phone ||
    orden.shipping_address?.phone ||
    orden.customer?.phone ||
    '';

  const partes = [
    orden.billing_address?.address1 || orden.shipping_address?.address1,
    orden.billing_address?.address2 || orden.shipping_address?.address2,
    orden.billing_address?.city || orden.shipping_address?.city,
    orden.billing_address?.country || orden.shipping_address?.country,
  ].filter(Boolean);
  const direccion = partes.join(', ') || '';

  return {
    numeroIdentificacion,
    nombre: nombre.trim(),
    email: (email || '').trim(),
    telefono: (telefono || '').trim(),
    direccion,
  };
}

module.exports = {
  extraerClienteDeShopify,
};
