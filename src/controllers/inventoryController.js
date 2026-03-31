const path = require("path");
const fs = require("fs").promises;
const axios = require("axios");
const config = require("../config");
const inventoryBuildService = require("../services/inventoryBuildService");

const RESULT_PATH = path.join(process.cwd(), "result.json");
const INVENTORY_PATH = path.join(process.cwd(), "inventory.json");

async function getManageInventory(req, res) {
  try {
    const result = await inventoryBuildService.buildInventoryFiles(req.query);

    return res.status(200).json({
      ok: true,
      savedTo: "result.json",
      path: result.resultPath,
      bytesWritten: result.bytesResult,
      savedToInventory: "inventory.json",
      pathInventory: result.inventoryPath,
      bytesWrittenInventory: result.bytesInventory,
      data: result.data,
    });
  } catch (err) {
    const status = err?.response?.status ?? 500;
    const payload =
      err?.response?.data != null
        ? err.response.data
        : { message: err?.message || String(err) };
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      ok: false,
      error: payload,
    });
  }
}

async function getManageInventoryShopify(req, res) {
  try {
    const admin = config.shopify?.admin || {};
    const storeDomain = admin.storeDomain || "";
    const apiVersion = admin.apiVersion || "2026-01";
    const clientId = admin.oauthClientId || "";
    const clientSecret = admin.oauthClientSecret || "";

    if (!storeDomain) {
      return res.status(400).json({
        ok: false,
        error: { message: "SHOPIFY_STORE_DOMAIN no configurado" },
      });
    }
    if (!clientId || !clientSecret) {
      return res.status(400).json({
        ok: false,
        error: { message: "SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET no configurados" },
      });
    }

    // 1) OAuth client_credentials -> access_token
    const tokenUrl = `https://${storeDomain}/admin/oauth/access_token`;
    const form = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    });

    const tokenResp = await axios.post(tokenUrl, form.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });

    const accessToken = tokenResp?.data?.access_token || tokenResp?.data?.accessToken;
    if (!accessToken) {
      return res.status(502).json({
        ok: false,
        error: { message: "Shopify: no se recibió access_token" },
      });
    }

    // 2) Consultar productos
    const productsUrl = `https://${storeDomain}/admin/api/${apiVersion}/products.json`;
    const productsResp = await axios.get(productsUrl, {
      headers: { "X-Shopify-Access-Token": accessToken },
    });

    const data = productsResp.data;
    const text = JSON.stringify(data, null, 2);
    await fs.writeFile(RESULT_PATH, text, "utf8");

    return res.status(200).json({
      ok: true,
      savedTo: "result.json",
      path: RESULT_PATH,
      bytesWritten: Buffer.byteLength(text, "utf8"),
      data,
    });
  } catch (err) {
    const status = err?.response?.status ?? 500;
    const payload =
      err?.response?.data != null
        ? err.response.data
        : { message: err?.message || String(err) };
    return res.status(status >= 400 && status < 600 ? status : 502).json({
      ok: false,
      error: payload,
    });
  }
}

module.exports = {
  getManageInventory,
  getManageInventoryShopify,
};
