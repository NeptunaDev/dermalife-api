const express = require("express");
const inventoryController = require("../controllers/inventoryController");

const router = express.Router();

router.get("/manage-inventory", inventoryController.getManageInventory);

module.exports = router;
