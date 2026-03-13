const axios = require("axios");
const config = require("../config");
const logger = require("./logger");
const { getAuthHeaders, invalidateToken } = require("./hgiAuthService");

const base = (config.hgi.baseUrl || "").replace(/\/$/, "");

async function garantizarTercero(datosCliente, retry = false) {
  const payload = [
    {
      NumeroIdentificacion: datosCliente.numeroIdentificacion,
      Nombre: datosCliente.nombre,
      Direccion: datosCliente.direccion || "",
      CodigoCiudad: "",
      Telefono: datosCliente.telefono || "",
      Email: datosCliente.email || "",
      CodigoTipoTercero: "",
      CodigoVendedor: "84",
    },
  ];

  const headers = await getAuthHeaders();
  const url = `${base}/Api/Terceros/Crear`;
  const { status } = await axios.post(url, payload, {
    headers,
    validateStatus: () => true,
  });

  if (status === 200) {
    logger.stepOk(
      `HGI: tercero garantizado ${datosCliente.numeroIdentificacion}`,
    );
    return;
  }

  if (status === 401) {
    if (retry) {
      logger.stepErr("HGI Terceros: 401 tras reintento");
      throw new Error("HGI: no autorizado");
    }
    invalidateToken();
    logger.stepInfo("HGI Terceros: 401, invalidando token y reintentando...");
    return garantizarTercero(datosCliente, true);
  }

  throw new Error(`HGI Terceros/Crear: ${status}`);
}

module.exports = {
  garantizarTercero,
};
