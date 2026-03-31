const express = require("express");
const inventoryController = require("../controllers/inventoryController");

const router = express.Router();

router.get("/manage-inventory", inventoryController.getManageInventory);
router.get(
  "/manage-inventory-shopify",
  inventoryController.getManageInventoryShopify,
);

module.exports = router;
