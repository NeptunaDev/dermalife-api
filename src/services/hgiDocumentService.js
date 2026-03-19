const config = require("../config");
const logger = require("./logger");
const hgiCacheService = require("./hgiCacheService");
const { hgiRequest } = require("./hgiAuthService");

const base = (config.hgi?.baseUrl || "").replace(/\/$/, "");

async function crearEncabezadoFAC(docData) {
  const payload = [
    {
      Empresa: 1,
      Compania: 1,
      Transaccion: "67",
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
      Bodega: "5",
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

async function crearDetalleFAC(numeroDoc, item, numeroIdentificacion, fecha) {
  console.log("🚀 ~ crearDetalleFAC ~ item:", item);
  const unidad = hgiCacheService.obtenerUnidadProducto(item.sku);

  const payload = [
    {
      Empresa: 1,
      Transaccion: "67",
      Documento: numeroDoc,
      Producto: item.sku,
      Cantidad: item.quantity,
      Bodega: "5",
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
      CantidadDocumento: 0,
      Fecha1: fecha,
      Fecha2: fecha,
      ProductoDescripcion: "0",
      ActivoFijo: "0",
    },
  ];
  console.log("🚀 ~ crearDetalleFAC ~ payload:", payload);

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
  logger.stepOk(`HGI: detalle creado para SKU ${item.sku}`);
}

module.exports = {
  crearEncabezadoFAC,
  crearDetalleFAC,
};
