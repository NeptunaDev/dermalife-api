require("dotenv").config();
const axios = require("axios");

const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c3VhcmlvIjoiYWRtaW4iLCJjbGF2ZSI6Ik5ldG1hc2syIiwiY29kX2NvbXBhbmlhIjoiMSIsImNvZF9lbXByZXNhIjoiMSIsImVzdGFkbyI6IjEiLCJpZF9hcGxpY2F0aXZvIjoiMTEiLCJpZF9hcGxpY2F0aXZvX3BldGljaW9uIjoiMTEiLCJuYmYiOjE3NzM3NjQ5OTMsImV4cCI6MTc3Mzc4NTk5MywiaWF0IjoxNzczNzY0OTkzfQ.KDdXpqf9Vp2_CgQE6LN5G0ACSns3yPtvLBHuSUwshFY";

const BASE_URL = process.env.HGI_BASE_URL;
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

async function test() {
  try {
    // Paso 2: crear tercero
    console.log("── Paso 2: crear tercero en HGI ──");
    const r2 = await axios.post(
      `${BASE_URL}/Api/Terceros/Crear`,
      [
        {
          NumeroIdentificacion: "7001234567",
          Nombre: "Juan Cardona",
          Direccion: "cra 50A #76 sur 111",
          CodigoCiudad: "04",
          Telefono: "",
          Email: "cardonaospinajuanesteban@gmail.com",
          CodigoTipoTercero: "10",
          CodigoVendedor: "51",
          CodigoSucursal: "1",
          CodigoCausaRetiro: "0",
        },
      ],
      { headers, timeout: 10000 },
    );
    const terceroError = r2.data[0]?.Error;
    if (
      terceroError &&
      terceroError.Codigo !== 0 &&
      terceroError.Mensaje !== "" &&
      !terceroError.Mensaje.includes("ya se encuentra registrado")
    ) {
      throw new Error(`Tercero error: ${terceroError.Mensaje}`);
    }
    console.log("✅ Tercero OK (o ya existía)");

    // Paso 3: crear FAC
    console.log("\n── Paso 3: crear FAC en HGI ──");
    const r3 = await axios.post(
      `${BASE_URL}/Api/Documentos/Crear`,
      [
        {
          Empresa: 1,
          Compania: 1,
          Transaccion: "67",
          NumeroDocumento: "SHOP-6789001007",
          Fecha: new Date().toISOString().split(".")[0],
          Ano: new Date().getFullYear(),
          Periodo: new Date().getMonth() + 1,
          Tercero: "7001234567",
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
          ValorTotal: 1.19,
          Observaciones:
            "Orden Shopify #1003 - cardonaospinajuanesteban@gmail.com",
        },
      ],
      { headers, timeout: 15000 },
    );
    console.log("✅ FAC OK:", JSON.stringify(r3.data, null, 2));

    const docError = r3.data[0]?.Error;
    if (docError && docError.Codigo !== 0) {
      throw new Error(`Documento error: ${docError.Mensaje}`);
    }

    const numeroDoc = r3.data[0].Numero;
    console.log(`✅ Documento creado: #${numeroDoc}`);

    console.log("\n── Paso 3.5: unidades disponibles ──");
    const r35 = await axios.get(`${BASE_URL}/Api/Unidades/Obtener?codigo=*`, {
      headers,
      timeout: 10000,
    });
    console.log("✅ Unidades:", JSON.stringify(r35.data, null, 2));
    // Paso 4: crear detalle de la FAC
    console.log("\n── Paso 4: crear detalle FAC ──");
    const r4 = await axios.post(
      `${BASE_URL}/Api/Documentos/CrearDetalle`,
      [
        {
          Empresa: 1,
          Transaccion: "67",
          Documento: numeroDoc,
          Producto: "31017",
          Cantidad: 1,
          PrecioUnitario: 1.19,
          Bodega: "5",
          Tercero: "7001234567",
          Vinculado: "0",
          Sucursal: "0",
          CentroCosto: "0",
          SubcentroCosto: "0",
          Vendedor: "84",
          Unidad: "G",
          Talla: "0",
          Color: "0",
          Lote: "0",
          Serie1: "0",
          Serie2: "0", // ← agregar
          Serie3: "0", // ← agregar
          Descripcion1: "0",
          CodigoUbicacion: "0", // ← agregar
          CantidadDocumento: 0, // ← agregar
          Fecha1: new Date().toISOString().split(".")[0],
          Fecha2: new Date().toISOString().split(".")[0],
          ProductoDescripcion: "0",
          ActivoFijo: "0",
        },
      ],
      { headers, timeout: 15000 },
    );
    console.log("✅ Detalle OK:", JSON.stringify(r4.data, null, 2));
  } catch (error) {
    console.error("❌ Error:");
    console.error("  Status:", error.response?.status);
    console.error("  Data:", JSON.stringify(error.response?.data, null, 2));
    console.error("  Message:", error.message);
  }
}

test();
