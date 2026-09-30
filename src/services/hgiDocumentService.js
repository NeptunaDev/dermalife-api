const config = require("../config");
const logger = require("./logger");
const hgiCacheService = require("./hgiCacheService");
const { hgiRequest } = require("./hgiAuthService");

const base = (config.hgi?.baseUrl || "").replace(/\/$/, "");

function redondear2(valor) {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function resolverTransaccionPorGateway(paymentGatewayNames) {
  if (!Array.isArray(paymentGatewayNames)) return "67";

  const gatewaysNormalizados = paymentGatewayNames
    .filter((gateway) => typeof gateway === "string")
    .map((gateway) => gateway.toLowerCase());

  if (gatewaysNormalizados.some((gateway) => gateway.includes("addi payment"))) {
    return "108";
  }

  if (gatewaysNormalizados.some((gateway) => gateway.includes("wompi"))) {
    return "67";
  }

  return "67";
}

async function crearEncabezadoFAC(docData) {
  const transaccion = resolverTransaccionPorGateway(docData?.payment_gateway_names);
  const payload = [
    {
      Empresa: 1,
      Compania: 1,
      Transaccion: transaccion,
      NumeroDocumento: docData.numeroDocumento,
      Fecha: docData.fecha,
      Ano: docData.ano,
      Periodo: docData.periodo,
      Tercero: docData.numeroIdentificacion,
      Vinculado: "0",
      TerceroAuxiliar: "0",
      TransaccionAuxiliar: "0",
      Vendedor: "51",
      Transportador: "0",
      BodegaDestino: "0",
      Bodega: "1",
      Clase: "0",
      Moneda: "0",
      Sucursal: "0",
      CentroCosto: "0",
      SubcentroCosto: "0",
      Local: "0",
      TipoEvento: "0",
      ProductoP: "0",
      CantidadP: 0,
      BaseP: 0,
      Referencia: "0",
      Referencia1: "0",
      Referencia2: "0",
      Referencia3: "0",
      UsuarioGraba: "admin",
      ValorTotal: docData.total,
      Observaciones: docData.observaciones,
    },
  ];

  const url = `${base}/Api/Documentos/Crear`;
  const { data } = await hgiRequest({
    method: "post",
    url,
    headers: { "Content-Type": "application/json" },
    data: payload,
  });

  const first = Array.isArray(data) ? data[0] : data;
  const err = first?.Error;
  if (err != null) {
    const mensaje = err.Mensaje ?? err.mensaje ?? JSON.stringify(err);
    throw new Error(mensaje);
  }
  const numero = first?.Numero ?? first?.numero;
  if (numero == null) {
    throw new Error("HGI: respuesta Crear encabezado sin Numero");
  }
  logger.stepOk(`HGI: encabezado FAC creado, Numero=${numero}`);
  return numero;
}

async function crearDetalleFAC(
  numeroDoc,
  item,
  numeroIdentificacion,
  fecha,
  paymentGatewayNames,
) {
  const cantidad = Number(item.cantidad);
  if (!Number.isFinite(cantidad) || cantidad <= 0) {
    logger.stepErr(
      `HGI CrearDetalle: cantidad inválida para SKU ${item.sku}: ${item.cantidad}`,
    );
    return;
  }

  const unidad = hgiCacheService.obtenerUnidadProducto(item.sku);
  const transaccion = resolverTransaccionPorGateway(paymentGatewayNames);

  // Tarifa de IVA real del producto (fracción: 0.19, 0.05, o 0 si es exento). Confirmado
  // con FAC #18576 (SKU 65154, IVA 19%) y FAC #18577 (SKU 15323, ValorIva=0 → sin dividir):
  // HGI espera ValorTotal/ValorDescuento SIN el IVA (divididos por 1+tarifa), mientras que
  // ValorUnitario va con IVA incluido (compare_at_price crudo, sin dividir).
  const tarifaIva = hgiCacheService.obtenerTarifaIvaProducto(item.sku) ?? config.hgi.ivaRateDefault;
  const factorIva = 1 + tarifaIva;
  const valorTotalSinIva = redondear2((item.valorTotal ?? 0) / factorIva);
  const valorDescuentoSinIva = redondear2((item.valorDescuento ?? 0) / factorIva);

  const payload = [
    {
      Empresa: 1,
      Transaccion: transaccion,
      Documento: numeroDoc,
      Producto: item.sku,
      Cantidad: cantidad,
      // ValorUnitario va crudo (con IVA incluido, sin dividir); ValorTotal y ValorDescuento
      // van divididos por (1+tarifaIva) para que HGI calcule Total = ValorTotal - ValorDescuento
      // y luego reintroduzca el IVA al mostrarlo. PorcentajeDescuento no se divide.
      ValorUnitario: item.valorUnitario ?? 0,
      ValorTotal: valorTotalSinIva,
      PorcentajeDescuento: item.porcentajeDescuento ?? 0,
      ValorDescuento: valorDescuentoSinIva,
      Bodega: "1",
      Tercero: numeroIdentificacion,
      Vinculado: "0",
      Sucursal: "0",
      CentroCosto: "0",
      SubcentroCosto: "0",
      Vendedor: "51",
      Unidad: unidad,
      Talla: "0",
      Color: "0",
      Lote: "0",
      Serie1: "0",
      Serie2: "0",
      Serie3: "0",
      Descripcion1: "0",
      CodigoUbicacion: "0",
      // HGI suele persistir la cantidad del ítem del documento en este campo;
      // si se deja en 0, la respuesta devuelve Cantidad/CantidadDocumento en 0 aunque envíes Cantidad.
      CantidadDocumento: cantidad,
      Fecha1: fecha,
      Fecha2: fecha,
      ProductoDescripcion: "0",
      ActivoFijo: "0",
    },
  ];

  const camposUnidad = hgiCacheService.obtenerCamposUnidadProducto(item.sku);
  logger.stepInfo(
    `HGI CrearDetalle payload SKU ${item.sku}: ${JSON.stringify(payload, null, 2)}`,
  );
  logger.stepInfo(
    `HGI Cache: campos de unidad para SKU ${item.sku}: ${
      camposUnidad == null
        ? "producto no encontrado en caché"
        : JSON.stringify(camposUnidad)
    }`,
  );

  const url = `${base}/Api/Documentos/CrearDetalle`;
  const { data } = await hgiRequest({
    method: "post",
    url,
    headers: { "Content-Type": "application/json" },
    data: payload,
  });
  const first = Array.isArray(data) ? data[0] : data;
  const err = first?.Error;
  if (err != null) {
    const mensaje = err.Mensaje ?? err.mensaje ?? JSON.stringify(err);
    logger.stepErr(`HGI CrearDetalle SKU ${item.sku}: ${mensaje}`);
    return;
  }
  logger.stepOk(
    `HGI: detalle creado para SKU ${item.sku} (valorUnitario=${item.valorUnitario}, valorTotal=${item.valorTotal}, descuento=${item.valorDescuento ?? 0}, %descuento=${item.porcentajeDescuento ?? 0})`,
  );
}

module.exports = {
  crearEncabezadoFAC,
  crearDetalleFAC,
};
