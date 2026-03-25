const path = require("path");
const fs = require("fs").promises;
const hgiInventoryService = require("../services/hgiInventoryService");

const RESULT_PATH = path.join(process.cwd(), "result.json");
const INVENTORY_PATH = path.join(process.cwd(), "inventory.json");

async function getManageInventory(req, res) {
  try {
    const raw = await hgiInventoryService.obtenerInventario(req.query);
    const grouped =
      hgiInventoryService.agruparInventarioPorProductoYBodega(raw);
    const textResult = JSON.stringify(grouped, null, 2);
    await fs.writeFile(RESULT_PATH, textResult, "utf8");

    const productos =
      hgiInventoryService.obtenerProductosPorCodigoDesdeJson();
    const data = hgiInventoryService.enriquecerInventarioConProductos(
      grouped,
      productos,
    );
    const textInventory = JSON.stringify(data, null, 2);
    await fs.writeFile(INVENTORY_PATH, textInventory, "utf8");

    return res.status(200).json({
      ok: true,
      savedTo: "result.json",
      path: RESULT_PATH,
      bytesWritten: Buffer.byteLength(textResult, "utf8"),
      savedToInventory: "inventory.json",
      pathInventory: INVENTORY_PATH,
      bytesWrittenInventory: Buffer.byteLength(textInventory, "utf8"),
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
};
