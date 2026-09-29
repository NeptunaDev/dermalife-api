const axios = require("axios");
const config = require("../config");
const logger = require("./logger");

const { storeDomain, apiVersion, oauthClientId, oauthClientSecret } = config.shopify.admin;

let cachedToken = "";

function estaConfigurado() {
  return Boolean(storeDomain && oauthClientId && oauthClientSecret);
}

async function fetchAccessToken() {
  const tokenUrl = `https://${storeDomain}/admin/oauth/access_token`;
  const form = new URLSearchParams({
    client_id: oauthClientId,
    client_secret: oauthClientSecret,
    grant_type: "client_credentials",
  });

  const { data } = await axios.post(tokenUrl, form.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });

  const token = data?.access_token || data?.accessToken;
  if (!token) {
    throw new Error("Shopify OAuth no devolvió access_token");
  }
  return token;
}

async function obtenerAccessToken() {
  if (cachedToken) return cachedToken;
  cachedToken = await fetchAccessToken();
  return cachedToken;
}

async function graphqlRequest(query, variables) {
  if (!estaConfigurado()) {
    throw new Error(
      "Shopify Admin API no configurada (faltan SHOPIFY_STORE_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET en .env)",
    );
  }

  const url = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;

  const ejecutar = (token) =>
    axios.post(
      url,
      { query, variables },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        timeout: 15000,
      },
    );

  let token = await obtenerAccessToken();
  let response;
  try {
    response = await ejecutar(token);
  } catch (error) {
    if (error.response?.status === 401) {
      cachedToken = "";
      token = await obtenerAccessToken();
      response = await ejecutar(token);
    } else {
      throw error;
    }
  }

  const errors = response.data?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(errors)}`);
  }
  return response.data?.data || {};
}

/**
 * Obtiene compareAtPrice para una lista de variant_id numéricos (line_items[].variant_id).
 * Un solo request GraphQL por orden, sin importar cuántos line_items tenga.
 * @param {Array<number|string>} variantIds
 * @returns {Promise<Map<string, number|null>>} clave = variant_id como string
 */
async function obtenerCompareAtPricePorVariantIds(variantIds) {
  const idsUnicos = [...new Set((variantIds || []).filter((id) => id != null))].map(String);
  if (idsUnicos.length === 0) return new Map();

  const gids = idsUnicos.map((id) => `gid://shopify/ProductVariant/${id}`);
  const query = `
    query VariantesCompareAtPrice($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          compareAtPrice
        }
      }
    }
  `;

  const data = await graphqlRequest(query, { ids: gids });
  const mapa = new Map();
  for (const node of data?.nodes || []) {
    if (!node?.id) continue;
    const variantId = node.id.split("/").pop();
    const valor = node.compareAtPrice != null ? parseFloat(node.compareAtPrice) : null;
    mapa.set(variantId, Number.isFinite(valor) ? valor : null);
  }
  return mapa;
}

module.exports = {
  estaConfigurado,
  obtenerCompareAtPricePorVariantIds,
};
