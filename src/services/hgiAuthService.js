const axios = require("axios");
const config = require("../config");
const logger = require("./logger");

const TOKEN_TTL_MS = 20 * 60 * 1000; // 20 min
const RENEW_MARGIN_MS = 2 * 60 * 1000; // renovar con 2 min de margen
const MAX_REINTENTOS_CODIGO_3 = 3;
const ESPERA_CODIGO_3_MS = 21 * 1000; // 21 s

let token = null;
let obtainedAt = null;
let expiresAt = null;

async function fetchToken(reintento = 0) {
  const { baseUrl, usuario, clave, codCompania, codEmpresa } = config.hgi;
  if (!baseUrl || !usuario || !clave) {
    throw new Error(
      "HGI: faltan HGI_BASE_URL, HGI_USUARIO o HGI_CLAVE en .env",
    );
  }
  const url = `${baseUrl.replace(/\/$/, "")}/Api/Autenticar`;
  const params = {
    usuario,
    clave,
    cod_compania: codCompania,
    cod_empresa: codEmpresa,
  };
  logger.stepInfo("HGI: solicitando token...");
  const { data } = await axios.get(url, { params });

  if (data?.Error != null && data.Error.Codigo !== 3) {
    const mensaje =
      data.Error.Mensaje ?? data.Error.mensaje ?? String(data.Error);
    logger.stepErr("HGI: error de autenticación: " + mensaje);
    throw new Error("HGI: " + mensaje);
  }

  if (data?.Error?.Codigo === 3) {
    if (reintento < MAX_REINTENTOS_CODIGO_3) {
      logger.stepInfo(
        "HGI: token anterior aún activo en HGI, esperando 21s...",
      );
      await new Promise((resolve) =>
        setTimeout(resolve, ESPERA_CODIGO_3_MS),
      );
      return fetchToken(reintento + 1);
    }
    logger.stepErr(
      "HGI: no se pudo obtener token después de 3 intentos (token aún vigente en HGI)",
    );
    throw new Error(
      "No se pudo obtener token HGI después de 3 intentos",
    );
  }

  const value =
    data?.JwtToken ?? data?.Token ?? data?.token ?? data?.access_token;
  if (!value) {
    logger.stepErr("HGI: respuesta de autenticación sin token");
    throw new Error("HGI: respuesta sin token");
  }

  token = value;
  obtainedAt = Date.now();
  expiresAt = obtainedAt + TOKEN_TTL_MS;
  logger.stepOk("HGI: token obtenido");
  return token;
}

function invalidateToken() {
  token = null;
  obtainedAt = null;
  expiresAt = null;
  logger.stepInfo("HGI: token invalidado");
}

async function getToken() {
  const now = Date.now();
  if (
    token &&
    expiresAt != null &&
    expiresAt - now > RENEW_MARGIN_MS
  ) {
    logger.stepInfo("HGI: usando token en memoria (aún vigente)");
    return token;
  }
  return fetchToken(0);
}

async function getAuthHeaders() {
  const t = await getToken();
  return {
    Authorization: `Bearer ${t}`,
    "Content-Type": "application/json",
  };
}

module.exports = {
  getToken,
  getAuthHeaders,
  invalidateToken,
};
