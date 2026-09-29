/**
 * Crea un documento de PRUEBA aislado en HGI (no toca la FAC #18577 real) con 2
 * líneas de detalle que prueban, cada una, un nombre de campo distinto para el
 * precio unitario:
 *   - Línea 1 (cantidad 1, SKU 31017): manda "PrecioUnitario" = 111  (Alternativa B)
 *   - Línea 2 (cantidad 1, SKU 31017): manda "ValorUnitario" = 222, SIN ValorDescuento
 *     ni PorcentajeDescuento (Alternativa A)
 *
 * Corre esto y luego revisa en HGI el documento "TEST-CAMPO-<timestamp>":
 *   - Si la línea 1 muestra Vr Unitario = 111  -> el campo correcto es PrecioUnitario.
 *   - Si la línea 2 muestra Vr Unitario = 222  -> ValorUnitario sí funciona (el problema
 *     era el ValorDescuento/PorcentajeDescuento, no el nombre del campo de precio).
 *   - Si NINGUNA muestra el valor esperado -> el problema es otra cosa (transacción,
 *     bodega, tercero, etc.) y hay que seguir investigando antes de tocar el mapper.
 *
 * IMPORTANTE: debe correrse desde una máquina con acceso de red a HGI_BASE_URL,
 * parado en la raíz del proyecto (donde está package.json), con `npm install` ya
 * hecho y el .env con HGI_BASE_URL / HGI_USUARIO / HGI_CLAVE configurados.
 *
 * Uso: node scripts/test-nombre-campo-precio.js
 */
require("dotenv").config();
const { hgiRequest } = require("../src/services/hgiAuthService");
const config = require("../src/config");

const base = (config.hgi.baseUrl || "").replace(/\/$/, "");
const SKU_PRUEBA = "31017"; // el mismo que usó test-hgi.js originalmente
const NIT_PRUEBA = "7001234567";
const TRANSACCION = "67";

function fechaHoraHgi() {
  return new Date().toISOString().split(".")[0];
}

async function main() {
  if (!base) throw new Error("HGI_BASE_URL no configurado en .env");

  // 1) Tercero de prueba (ya existía de la prueba anterior; si ya existe, HGI responde
  //    "ya se encuentra registrado" y seguimos igual).
  console.log("── Paso 1: tercero de prueba ──");
  const rTercero = await hgiRequest({
    method: "post",
    url: `${base}/Api/Terceros/Crear`,
    headers: { "Content-Type": "application/json" },
    data: [
      {
        NumeroIdentificacion: NIT_PRUEBA,
        Nombre: "TEST CAMPO PRECIO",
        Direccion: "N/A",
        CodigoCiudad: "04",
        Telefono: "",
        Email: "test@example.com",
        CodigoTipoTercero: "10",
        CodigoVendedor: "51",
        CodigoSucursal: "1",
        CodigoCausaRetiro: "0",
      },
    ],
  });
  console.log("Tercero:", JSON.stringify(rTercero.data));

  // 2) Documento de prueba, claramente marcado como TEST (no es una orden de Shopify real).
  const numeroDocumentoTest = `TEST-CAMPO-${Date.now()}`;
  console.log(`\n── Paso 2: crear documento de prueba "${numeroDocumentoTest}" ──`);
  const rDoc = await hgiRequest({
    method: "post",
    url: `${base}/Api/Documentos/Crear`,
    headers: { "Content-Type": "application/json" },
    data: [
      {
        Empresa: 1,
        Compania: 1,
        Transaccion: TRANSACCION,
        NumeroDocumento: numeroDocumentoTest,
        Fecha: fechaHoraHgi(),
        Ano: new Date().getFullYear(),
        Periodo: new Date().getMonth() + 1,
        Tercero: NIT_PRUEBA,
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
        ValorTotal: 333,
        Observaciones: `PRUEBA nombre de campo precio unitario - ${numeroDocumentoTest}`,
      },
    ],
  });
  const docError = rDoc.data?.[0]?.Error;
  if (docError && docError.Codigo !== 0) {
    throw new Error(`Error creando documento: ${docError.Mensaje ?? JSON.stringify(docError)}`);
  }
  const numeroDoc = rDoc.data?.[0]?.Numero;
  console.log(`Documento creado. Numero interno HGI = ${numeroDoc}`);

  const detalleBase = {
    Empresa: 1,
    Transaccion: TRANSACCION,
    Documento: numeroDoc,
    Producto: SKU_PRUEBA,
    Cantidad: 1,
    Bodega: "1",
    Tercero: NIT_PRUEBA,
    Vinculado: "0",
    Sucursal: "0",
    CentroCosto: "0",
    SubcentroCosto: "0",
    Vendedor: "51",
    Unidad: "UND",
    Talla: "0",
    Color: "0",
    Lote: "0",
    Serie1: "0",
    Serie2: "0",
    Serie3: "0",
    Descripcion1: "0",
    CodigoUbicacion: "0",
    CantidadDocumento: 1,
    Fecha1: fechaHoraHgi(),
    Fecha2: fechaHoraHgi(),
    ProductoDescripcion: "0",
    ActivoFijo: "0",
  };

  // 3) Línea 1: Alternativa B -> PrecioUnitario
  console.log("\n── Paso 3: detalle 1 (Alternativa B: PrecioUnitario = 111) ──");
  const rDet1 = await hgiRequest({
    method: "post",
    url: `${base}/Api/Documentos/CrearDetalle`,
    headers: { "Content-Type": "application/json" },
    data: [
      {
        ...detalleBase,
        PrecioUnitario: 111,
      },
    ],
  });
  console.log("Respuesta detalle 1:", JSON.stringify(rDet1.data, null, 2));

  // 4) Línea 2: Alternativa A -> ValorUnitario, sin descuento
  console.log("\n── Paso 4: detalle 2 (Alternativa A: ValorUnitario = 222, sin descuento) ──");
  const rDet2 = await hgiRequest({
    method: "post",
    url: `${base}/Api/Documentos/CrearDetalle`,
    headers: { "Content-Type": "application/json" },
    data: [
      {
        ...detalleBase,
        ValorUnitario: 222,
        ValorTotal: 222,
      },
    ],
  });
  console.log("Respuesta detalle 2:", JSON.stringify(rDet2.data, null, 2));

  console.log(
    `\n✅ Listo. Revisa en HGI el documento "${numeroDocumentoTest}" (Numero interno ${numeroDoc}, Transaccion ${TRANSACCION}) y compara Vr Unitario de cada línea contra 111 y 222.`,
  );
}

main().catch((error) => {
  console.error("❌ Error:", error.response?.data || error.message);
  process.exitCode = 1;
});
