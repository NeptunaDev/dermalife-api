require("dotenv").config();
const axios = require("axios");

// Pega aquí el token que ya tienes activo en Postman
const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c3VhcmlvIjoiYWRtaW4iLCJjbGF2ZSI6Ik5ldG1hc2syIiwiY29kX2NvbXBhbmlhIjoiMSIsImNvZF9lbXByZXNhIjoiMSIsImVzdGFkbyI6IjEiLCJpZF9hcGxpY2F0aXZvIjoiMTEiLCJpZF9hcGxpY2F0aXZvX3BldGljaW9uIjoiMTEiLCJuYmYiOjE3NzMzNjQzODksImV4cCI6MTc3MzM4NTM4OSwiaWF0IjoxNzczMzY0Mzg5fQ.__dtKQGWZIDqKgZOezKPOkfGIwGm3SIjzMdAOxLtoEg";

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
          CodigoVendedor: "84",
          CodigoSucursal: "1",
          CodigoCausaRetiro: "0",
        },
      ],
      { headers, timeout: 10000 },
    );
    console.log("✅ Tercero OK:", JSON.stringify(r2.data, null, 2));

    // Paso 3: crear FAC
    console.log("\n── Paso 3: crear FAC en HGI ──");
    const r3 = await axios.post(
      `${BASE_URL}/Api/Documentos/Crear`,
      [
        {
          Empresa: 1,
          Compania: 1,
          CodigoTransaccion: "FAC",
          NumeroDocumento: "SHOP-6789001003",
          Fecha: new Date().toISOString().split(".")[0], // ← usa la fecha actual
          NumeroIdentificacionTercero: "7001234567",
          CodigoVendedor: "84",
          CodigoBodega: "5",
          ValorTotal: 1.19,
          Observaciones:
            "Orden Shopify #1003 - cardonaospinajuanesteban@gmail.com",
        },
      ],
      { headers, timeout: 15000 },
    );
    console.log("✅ FAC OK:", JSON.stringify(r3.data, null, 2));
  } catch (error) {
    console.error("❌ Error:");
    console.error("  Status:", error.response?.status);
    console.error("  Data:", JSON.stringify(error.response?.data, null, 2));
    console.error("  Message:", error.message);
  }
}

test();
