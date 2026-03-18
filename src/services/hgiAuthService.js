const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const logger = require("./logger");

const CONSTANTS_PATH = path.resolve(__dirname, "../../data/CONSTANTS.txt");

const MAX_REINTENTOS_CODIGO_3 = 3;
const ESPERA_CODIGO_3_MS = 21 * 1000; // 21 s

let authInFlight = null; // evita múltiples auth simultáneos dentro del mismo proceso

function normalizeToken(value) {
  if (value == null) return "";
  const s = String(value).trim();
  return s === "null" ? "" : s;
}

function readTokenFromConstants() {
  try {
    const raw = fs.readFileSync(CONSTANTS_PATH, "utf8");
    const line = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith("TOKEN="));
    if (!line) return "";
    return normalizeToken(line.slice("TOKEN=".length));
  } catch (err) {
    logger.stepErr(`HGI: no se pudo leer ${CONSTANTS_PATH}: ${err.message}`);
    return "";
  }
}

function writeTokenToConstants(token) {
  const value = normalizeToken(token);
  if (!value) {
    // por seguridad, si llega vacío no escribimos "TOKEN=" para no romper el flujo.
    logger.stepErr("HGI: intento de escribir token vacío en CONSTANTS.txt");
    return;
  }

  try {
    const dir = path.dirname(CONSTANTS_PATH);
    const tmp = path.join(dir, `.CONSTANTS.txt.tmp.${process.pid}`);
    let raw = "";
    try {
      raw = fs.readFileSync(CONSTANTS_PATH, "utf8");
    } catch {
      raw = "";
    }

    const lines = raw.split(/\r?\n/);
    let found = false;
    const next = lines.map((l) => {
      if (l.trim().startsWith("TOKEN=")) {
        found = true;
        return `TOKEN=${value}`;
      }
      return l;
    });

    if (!found) next.push(`TOKEN=${value}`);
    fs.writeFileSync(tmp, next.join("\n"), "utf8");
    fs.renameSync(tmp, CONSTANTS_PATH);
  } catch (err) {
    logger.stepErr(`HGI: no se pudo actualizar CONSTANTS.txt: ${err.message}`);
    throw err;
  }
}

function maybeAuthFailureFromMessage(message) {
  if (!message) return false;
  const m = String(message).toLowerCase();
  return (
    m.includes("token") ||
    m.includes("jwt") ||
    m.includes("autent") ||
    m.includes("no autorizado") ||
    m.includes("unauthorized") ||
    m.includes("forbidden") ||
    m.includes("expir") ||
    m.includes("venc")
  );
}

function extractHgiAuthErrorFromPayload(data) {
  try {
    const first = Array.isArray(data) ? data[0] : data;
    const err = first?.Error ?? first?.error;
    if (!err) return null;
    const codigo = err.Codigo ?? err.codigo;
    const mensaje = err.Mensaje ?? err.mensaje ?? err.message ?? "";
    return { codigo, mensaje };
  } catch {
    return null;
  }
}

function isAuthFailurePayload(data) {
  const authErr = extractHgiAuthErrorFromPayload(data);
  if (!authErr) return false;

  const codigo = authErr.codigo != null ? Number(authErr.codigo) : null;
  if (codigo === 401 || codigo === 403) return true;
  if (codigo === 400 && maybeAuthFailureFromMessage(authErr.mensaje))
    return true;

  return maybeAuthFailureFromMessage(authErr.mensaje);
}

function isAuthFailureAxiosError(err) {
  const status = err?.response?.status;
  if (status === 401 || status === 403) return true;

  // Caso reportado: `400 Invalid token` (a veces sin body)
  const statusText = err?.response?.statusText;
  const data = err?.response?.data;
  const dataStr =
    data == null
      ? ""
      : typeof data === "string"
        ? data
        : JSON.stringify(data);
  const combined = [err?.message, statusText, dataStr].filter(Boolean).join(" ").toLowerCase();
  if (combined.includes("invalid token")) return true;

  const msg =
    err?.message ||
    err?.response?.data?.Error?.Mensaje ||
    err?.response?.data?.Error?.mensaje ||
    JSON.stringify(err?.response?.data ?? {});
  return maybeAuthFailureFromMessage(msg);
}

async function fetchTokenFromHgi(reintento = 0) {
  const { baseUrl, usuario, clave, codCompania, codEmpresa } = config.hgi;
  if (!baseUrl || !usuario || !clave) {
    throw new Error("HGI: faltan HGI_BASE_URL, HGI_USUARIO o HGI_CLAVE en .env");
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
    const mensaje = data.Error.Mensaje ?? data.Error.mensaje ?? String(data.Error);
    logger.stepErr("HGI: error de autenticación: " + mensaje);
    throw new Error("HGI: " + mensaje);
  }

  if (data?.Error?.Codigo === 3) {
    if (reintento < MAX_REINTENTOS_CODIGO_3) {
      logger.stepInfo("HGI: token anterior aún activo en HGI, esperando 21s...");
      await new Promise((resolve) => setTimeout(resolve, ESPERA_CODIGO_3_MS));
      return fetchTokenFromHgi(reintento + 1);
    }
    logger.stepErr(
      "HGI: no se pudo obtener token después de 3 intentos (token aún vigente en HGI)",
    );
    // Se deja caer a retorno vacío para respetar la regla de reintento con CONSTANTS.txt
  }

  const value =
    data?.JwtToken ?? data?.Token ?? data?.token ?? data?.access_token;

  return normalizeToken(value);
}

async function refreshTokenFromHgiAndStore() {
  if (authInFlight) return authInFlight;

  authInFlight = (async () => {
    const tokenFromAuth = await fetchTokenFromHgi(0);
    if (tokenFromAuth) {
      writeTokenToConstants(tokenFromAuth);
      logger.stepOk("HGI: token obtenido y guardado en CONSTANTS.txt");
      return tokenFromAuth;
    }

    // Regla solicitada: JwtToken null o "" -> otra petición ya ajustó.
    logger.stepInfo("HGI: auth devolvió token vacío; releyendo CONSTANTS.txt...");
    for (let i = 0; i < 3; i++) {
      const tokenFromConstants = readTokenFromConstants();
      if (tokenFromConstants) return tokenFromConstants;
      // espera corta para dar tiempo a que el otro request actualice el archivo
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("HGI: token vacío también en CONSTANTS.txt");
  })();

  try {
    return await authInFlight;
  } finally {
    authInFlight = null;
  }
}

async function hgiRequest(axiosRequestConfig, { retryOnAuthFailure = true } = {}) {
  const baseConfig = {
    ...axiosRequestConfig,
    headers: { ...(axiosRequestConfig?.headers || {}) },
  };

  let refreshed = false;
  // 1 intento con token de CONSTANTS + 1 reintento después de refresh (si aplica)
  for (let i = 0; i < 2; i++) {
    const storedToken = readTokenFromConstants();

    if (!storedToken) {
      if (!retryOnAuthFailure) throw new Error("HGI: TOKEN vacío en CONSTANTS.txt");
      logger.stepErr("HGI: TOKEN vacío en CONSTANTS.txt; refrescando token...");
      await refreshTokenFromHgiAndStore();
      refreshed = true;
      continue;
    }

    const attemptStart = Date.now();
    try {
      const res = await axios({
        ...baseConfig,
        headers: {
          ...baseConfig.headers,
          Authorization: `Bearer ${storedToken}`,
        },
      });
      const dt = Date.now() - attemptStart;
      logger.stepInfo(
        `HGI: request ok en ${dt}ms (${axiosRequestConfig?.method || 'request'} ${axiosRequestConfig?.url || ''})`,
      );

      if (retryOnAuthFailure && !refreshed && isAuthFailurePayload(res.data)) {
        logger.stepErr("HGI: error de token detectado en payload; refrescando y reintentando...");
        refreshed = true;
        await refreshTokenFromHgiAndStore();
        continue;
      }

      return res;
    } catch (err) {
      const dt = Date.now() - attemptStart;
      if (
        !retryOnAuthFailure ||
        refreshed ||
        !isAuthFailureAxiosError(err)
      ) {
        logger.stepErr(
          `HGI: request falló (sin reintento) en ${dt}ms (${axiosRequestConfig?.method || 'request'} ${axiosRequestConfig?.url || ''}): ${
            err?.response?.status ? `status=${err.response.status}` : 'error'
          } ${err?.message || ''}`,
        );
        throw err;
      }

      logger.stepErr("HGI: error de token (axios); refrescando y reintentando...");
      refreshed = true;
      await refreshTokenFromHgiAndStore();
    }
  }

  throw new Error("HGI: petición falló incluso después de refrescar token");
}

module.exports = {
  hgiRequest,
  refreshTokenFromHgiAndStore,
  // útil para debug/testing
  readTokenFromConstants,
};
