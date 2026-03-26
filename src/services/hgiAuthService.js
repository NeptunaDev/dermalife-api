const axios = require("axios");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const logger = require("./logger");
const hgiTokenService = require("./hgiTokenService");

const CONSTANTS_PATH = path.resolve(__dirname, "../../data/CONSTANTS.txt");

const MAX_REINTENTOS_CODIGO_3 = 3;
const ESPERA_CODIGO_3_MS = 21 * 1000; // 21 s

let authInFlight = null; // evita múltiples auth simultáneos dentro del mismo proceso

// Capa memoria: fuente principal en runtime
let tokenMemory = ""; // token actual en memoria
let tokenMemoryLoaded = false;
let tokenExpiresAtMs = null; // derived from JWT "exp" claim

// Cooldown para evitar repetir auth de forma agresiva si el refresh falla (escenario C)
const REFRESH_FAILURE_COOLDOWN_MS = 15 * 1000;
let refreshFailureUntil = 0;

// Renovar antes de expirar para evitar que el primer request falle
// (si el token trae exp, usaremos ese valor; si no, fallback a retry en caso de token inválido)
const TOKEN_RENEW_MARGIN_MS = 2 * 60 * 1000; // 2 min

function loadTokenFromDiskOnceIfNeeded() {
  if (tokenMemoryLoaded) return tokenMemory;
  // Fuente principal: DB (cross-proceso). Respaldo: CONSTANTS.txt para bootstrap.
  const tokenFromDb = hgiTokenService.getToken();
  if (tokenFromDb && tokenFromDb !== hgiTokenService.OBTEINENDO_TOKEN_VALUE) {
    setTokenMemory(tokenFromDb);
    return tokenMemory;
  }

  const tokenFromDisk = readTokenFromConstants();
  if (tokenFromDisk) {
    hgiTokenService.setToken(tokenFromDisk);
    setTokenMemory(tokenFromDisk);
    return tokenMemory;
  }

  // No hay token disponible (o está en lock 'OBTENIENDO'); evitamos usarlo.
  setTokenMemory("");
  return tokenMemory;
}

function setTokenMemory(value) {
  tokenMemory = normalizeToken(value);
  tokenMemoryLoaded = true;
  tokenExpiresAtMs = decodeJwtExpiresAtMs(tokenMemory);
}

function decodeJwtExpiresAtMs(token) {
  try {
    if (!token || token === "") return null;
    const parts = String(token).split(".");
    // JWT esperado: header.payload.signature
    if (parts.length < 2) return null;
    const payloadB64Url = parts[1];
    const payloadB64 = payloadB64Url.replace(/-/g, "+").replace(/_/g, "/");
    const padLen = (4 - (payloadB64.length % 4)) % 4;
    const payloadB64Padded = payloadB64 + "=".repeat(padLen);
    const payloadStr = Buffer.from(payloadB64Padded, "base64").toString("utf8");
    const payload = JSON.parse(payloadStr);
    const expSeconds = payload?.exp;
    if (typeof expSeconds !== "number") return null;
    return expSeconds * 1000;
  } catch {
    return null;
  }
}

function tokenShouldBeRefreshed() {
  if (!tokenMemory) return true;
  if (tokenExpiresAtMs == null) return false; // no sabemos expiración, no forzamos
  return tokenExpiresAtMs - Date.now() <= TOKEN_RENEW_MARGIN_MS;
}

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
    // Caso: el token todavía está vigente en HGI (JwtToken viene null).
    // En vez de esperar/reintentar, usamos el token que ya tenemos.
    const tokenActual = (() => {
      if (
        tokenMemoryLoaded &&
        tokenMemory &&
        tokenMemory !== hgiTokenService.OBTEINENDO_TOKEN_VALUE
      ) {
        return tokenMemory;
      }
      const t = hgiTokenService.getToken();
      if (t && t !== hgiTokenService.OBTEINENDO_TOKEN_VALUE) return t;
      return readTokenFromConstants();
    })();

    if (tokenActual) {
      logger.stepInfo(
        "HGI: /Api/Autenticar respondió Codigo=3 (token aún vigente); usando token actual del runtime/disco",
      );
      return normalizeToken(tokenActual);
    }

    // Si no tenemos token actual, cae a vacío para que el caller reintente según su estrategia.
    logger.stepErr(
      "HGI: /Api/Autenticar respondió Codigo=3 pero el token actual está vacío",
    );
    return "";
  }

  const value =
    data?.JwtToken ?? data?.Token ?? data?.token ?? data?.access_token;

  return normalizeToken(value);
}

async function refreshTokenFromHgiAndStore() {
  if (authInFlight) return authInFlight;

  authInFlight = (async () => {
    // Asegura tokenMemory cargado (incluye backup/seed si DB está vacía).
    const prevToken = loadTokenFromDiskOnceIfNeeded();

    // Mutex a nivel DB:
    // - si ganamos: token -> OBTENIENDO y ejecutamos /Api/Autenticar
    // - si perdemos: esperamos a que el token deje de ser OBTENIENDO y re-leemos
    const lockAcquired = hgiTokenService.tryAcquireObtainingLock();
    if (!lockAcquired) {
      for (let i = 0; i < 20; i++) {
        const t = hgiTokenService.getToken();
        if (t && t !== hgiTokenService.OBTEINENDO_TOKEN_VALUE) {
          setTokenMemory(t);
          return t;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      throw new Error("HGI: timeout esperando token (otro proceso refrescando)");
    }

    try {
      const tokenFromAuth = await fetchTokenFromHgi(0);

      // Caso: Codigo=3 (JwtToken null) -> fetchTokenFromHgi hace no-op y devuelve el token bueno.
      const tokenToStore =
        tokenFromAuth && tokenFromAuth !== hgiTokenService.OBTEINENDO_TOKEN_VALUE
          ? tokenFromAuth
          : prevToken;

      if (tokenToStore) {
        setTokenMemory(tokenToStore);
        hgiTokenService.setToken(tokenToStore);
        // compatibilidad: opcionalmente también persistimos en CONSTANTS.txt si existe
        try {
          writeTokenToConstants(tokenToStore);
        } catch {
          // noop
        }
        return tokenToStore;
      }

      hgiTokenService.setToken("");
      setTokenMemory("");
      throw new Error("HGI: auth no devolvió token utilizable");
    } catch (err) {
      // Escenario C: auth falla -> NO invalidamos el token anterior.
      const restore = prevToken || "";
      setTokenMemory(restore);
      hgiTokenService.setToken(restore);
      throw err;
    }
  })();

  try {
    return await authInFlight;
  } catch (err) {
    refreshFailureUntil = Date.now() + REFRESH_FAILURE_COOLDOWN_MS;
    throw err;
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
    const storedToken = loadTokenFromDiskOnceIfNeeded();

    if (!storedToken) {
      if (!retryOnAuthFailure) throw new Error("HGI: TOKEN vacío en CONSTANTS.txt");
      if (Date.now() < refreshFailureUntil) {
        throw new Error("HGI: TOKEN vacío y refresh en cooldown");
      }
      logger.stepErr("HGI: TOKEN vacío en CONSTANTS.txt; refrescando token...");
      await refreshTokenFromHgiAndStore();
      refreshed = true;
      continue;
    }

    // TTL proactivo basado en el claim "exp" del JWT (reduce el primer fallo aleatorio)
    if (tokenShouldBeRefreshed()) {
      if (Date.now() < refreshFailureUntil) {
        throw new Error("HGI: token requiere refresh pero refresh en cooldown");
      }
      logger.stepInfo("HGI: token próximo a expirar; refrescando antes de la petición...");
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
        if (Date.now() < refreshFailureUntil) {
          throw new Error("HGI: token inválido y refresh en cooldown");
        }
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
      if (Date.now() < refreshFailureUntil) {
        throw new Error("HGI: token inválido y refresh en cooldown");
      }
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
