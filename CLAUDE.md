# dermalife-api

Integración Shopify → HGInet ERP (HGI). Express + SQLite (`better-sqlite3`).

## Flujos

1. **Facturación** — `POST /webhook/order-completed` (HMAC activo): `orderService.processOrder`
   → idempotencia en `data/orders.db` → `compareAtPrice` vía Shopify Admin GraphQL
   → `mappers/shopifyToHgi.js` → ciudad (`data/ciudad/ciudad.json` + fuzzy)
   → `Terceros/Crear` (o `Actualizar` si ya existe) → `Documentos/Crear` (encabezado FAC)
   → `Documentos/CrearDetalle` por ítem.
2. **Inventario** — cron a las :00 y :30 (`inventoryCronService`): `/Api/Inventario/Obtener`
   → `inventory.json` → `scripts/inventory_shopify.js` (stock + compareAtPrice = Precio1).

Toda llamada a HGI pasa por `hgiRequest()` (`src/services/hgiAuthService.js`): JWT en la tabla
`hgi_token`, refresh proactivo, lock entre procesos. Ver `auth.md`.

## API de HGI

- La API real es REST + JWT: `{HGI_BASE_URL}/Api/<Servicio>/<Metodo>`, errores en `Error.Codigo/Mensaje`.
- El manual oficial (`ManualTecnicoHGInetServiciosWeb-v2019.2.pdf`) describe la versión WCF/SOAP
  anterior. Los modelos (Tercero, Documento, DocumentoDetalle, Transaccion, Saldo) se parecen, pero
  los nombres de campo hay que confirmarlos contra el servidor real.
- Secciones útiles del manual: 4.12 Terceros, 4.16 Ciudades (devuelve `Descripcion`, no `Nombre`),
  4.24 Tarifas IVA, 4.29 Documentos (Crear/CrearDetalle/Actualizar/ActualizarDetalle/EliminarDetallePorId),
  4.31 Transacciones (IvaIncluido, PrecioUnitario, CalculoIva, CapturaDescuento), 4.87 Inventarios.

## Reglas de valores en CrearDetalle (confirmadas con FAC #18576 y #18577)

- Transacción 67 (Wompi/por defecto) o 108 (Addi), según `payment_gateway_names`.
- `ValorUnitario` = precio de lista con IVA (compare_at_price, o price si no hay rebaja).
- `ValorTotal` y `ValorDescuento` van **sin IVA** (divididos por 1 + tarifa del producto).
- `PorcentajeDescuento` va como fracción (0-1), no como porcentaje.

## Pendiente de verificar contra HGI (cambios del tercero)

El tercero ahora envía Nombre1/Nombre2/Apellido1/Apellido2, TipoIdentificacion (`CC`),
CodigoTipoPersona, Celular, DireccionAlterna y EmailFacturaElectronica, y usa `Terceros/Actualizar`
cuando ya existe. `EmailFacturaElectronica` y el código `CC` no salen del manual. Si HGI no guarda
alguno, el log muestra `HGI Terceros/<Metodo>: campos enviados que HGI no devolvió: ...`.
Para ver los nombres reales: `GET /Api/Terceros/Obtener` sobre un tercero que facturó bien (FAC #18577).

## Precauciones

- HGI es el ERP de producción: leer es seguro; crear terceros o facturas deja registros reales.
  Confirmar con el usuario antes de cualquier escritura de prueba.
- Si `better-sqlite3` falla con `NODE_MODULE_VERSION`, correr `npm rebuild better-sqlite3`.

## Comandos

- `npm run dev` — desarrollo (`NODE_ENV=development`, logs detallados)
- `npm start` — producción
- No hay suite de tests; `test/` y `test-hgi.js` son scripts manuales.
