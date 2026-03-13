const axios = require("axios");
const config = require("../config");
const logger = require("./logger");

const TOKEN_TTL_MS = 20 * 60 * 1000; // 20 min
const RENEW_MARGIN_MS = 2 * 60 * 1000; // renovar con 2 min de margen

let token = null;
let expiresAt = null;

async function fetchToken() {
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
  if (data?.Error?.Codigo === 3) {
    logger.stepInfo("HGI: token aún vigente, esperando 5s...");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return fetchToken();
  }
  const value =
    data?.JwtToken ?? data?.Token ?? data?.token ?? data?.access_token;
  if (!value) {
    logger.stepErr("HGI: respuesta de autenticación sin token");
    throw new Error("HGI: respuesta sin token");
  }
  token = value;
  expiresAt = Date.now() + TOKEN_TTL_MS;
  logger.stepOk("HGI: token obtenido");
  return token;
}

function invalidateToken() {
  token = null;
  expiresAt = null;
  logger.stepInfo("HGI: token invalidado");
}

async function getToken() {
  const now = Date.now();
  if (token && expiresAt && expiresAt - now > RENEW_MARGIN_MS) {
    return token;
  }
  return fetchToken();
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
