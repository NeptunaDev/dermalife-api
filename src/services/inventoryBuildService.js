const path = require("path");
const fs = require("fs").promises;
const hgiInventoryService = require("./hgiInventoryService");

const RESULT_PATH = path.join(process.cwd(), "result.json");
const INVENTORY_PATH = path.join(process.cwd(), "inventory.json");

async function buildInventoryFiles(query = {}) {
  const raw = await hgiInventoryService.obtenerInventario(query);
  const grouped = hgiInventoryService.agruparInventarioPorProductoYBodega(raw);
  const textResult = JSON.stringify(grouped, null, 2);
  await fs.writeFile(RESULT_PATH, textResult, "utf8");

  const productos = hgiInventoryService.obtenerProductosPorCodigoDesdeJson();
  const data = hgiInventoryService.enriquecerInventarioConProductos(
    grouped,
    productos,
  );
  const textInventory = JSON.stringify(data, null, 2);
  await fs.writeFile(INVENTORY_PATH, textInventory, "utf8");

  return {
    data,
    resultPath: RESULT_PATH,
    inventoryPath: INVENTORY_PATH,
    bytesResult: Buffer.byteLength(textResult, "utf8"),
    bytesInventory: Buffer.byteLength(textInventory, "utf8"),
  };
}

module.exports = {
  buildInventoryFiles,
  RESULT_PATH,
  INVENTORY_PATH,
};
