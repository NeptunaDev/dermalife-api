# `POST /webhook/order-completed`: paso a paso (sin saltos)

Este documento describe, en el orden exacto en que ocurre, qué hace el endpoint `POST /webhook/order-completed` desde la llegada del webhook de Shopify hasta la respuesta final.

---

## 1. Entrada al servidor: ruta y body “raw”

El endpoint vive en `src/routes/webhookRoutes.js`.

1. Se registra la ruta:
   - `router.post('/order-completed', ...)`
2. Antes del controller se monta middleware de Express para recibir el body como “raw”:
   - `express.raw({ type: 'application/json' })`
3. La verificación HMAC de Shopify **está comentada** (no se ejecuta):
   - `// verifyShopifyHmac,`
   - El middleware `verifyShopifyHmac` existe en `src/middlewares/shopifyHmac.js`, pero está deshabilitado en esta ruta.

Cuando Express termina esos pasos, llama al handler:
- `webhookController.handleOrderCompleted`

---

## 2. Controller: `handleOrderCompleted(req, res)`

Archivo: `src/controllers/webhookController.js`.

1. Se imprime un header de logging:
   - `logger.section('Webhook orden completada recibido')`
   - `logger.stepInfo('Request POST /webhook/order-completed recibido')`
2. Se entra al `try` para procesar el body:
   1. Construye `bodyStr`:
      - Si `req.body` es `Buffer`, hace `req.body.toString('utf8')`.
      - Si no es Buffer, lo usa tal cual.
   2. Parsea el JSON:
      - `const payload = JSON.parse(bodyStr)`
   3. Loguea el payload completo:
      - `logger.payload('Payload crudo de Shopify', payload)`
3. Ejecuta el negocio principal:
   - `const result = await orderService.processOrder(req.body)`
   - Nota: pasa `req.body` (raw/Buffer), no el `payload` parseado.
4. Si todo sale bien:
   - Responde `200` con JSON:
     - `return res.status(200).json(result)`
5. Si ocurre un error en cualquier punto del `try`:
   1. Loguea el error:
      - `logger.section('ERROR EN PROCESAMIENTO')`
      - `logger.stepErr(error.message)`
   2. Responde igualmente `200` para evitar reintentos infinitos de Shopify:
      - `return res.status(200).json({ ok: false, error: error.message })`
   3. Si ya se enviaron headers, hace `return;` sin re-enviar.

En resumen: **la respuesta final del endpoint es exactamente el retorno de `orderService.processOrder(...)`** (en el caso éxito), o un JSON de error `{ ok: false, error: ... }` (en caso fallo).

---

## 3. Negocio principal: `orderService.processOrder(rawBody)`

Archivo: `src/services/orderService.js`.

`processOrder` es donde se ejecuta el flujo HGI. Sus pasos:

1. Log:
   - `logger.stepInfo('Convirtiendo body raw a JSON...')`
2. Parsea el rawBody recibido:
   - `const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody`
   - `const order = JSON.parse(bodyStr)`
   - Loguea que se parseó:
     - `logger.stepOk('Body parseado correctamente')`
3. Mapea el pedido a estructuras para HGI:
   - `const { terceroData, docData, items } = mapearOrdenShopifyParaHGI(order)`
   - Loguea:
     - `logger.stepInfo(...)` incluyendo `terceroData.numeroIdentificacion` y cantidad de ítems.
4. Valida que existan ítems con `sku`:
   - Si `items.length === 0`:
     - `throw new Error('No hay ítems con SKU para facturar en HGI')`
5. Obtiene el código de ciudad desde la cache:
   - Log:
     - `logger.stepInfo('Obteniendo código ciudad desde caché...')`
   - Llama:
     - `const codigoCiudad = hgiCacheService.obtenerCodigoCiudad(terceroData.ciudad)`
   - Guarda el código en el objeto del tercero:
     - `terceroData.codigoCiudad = codigoCiudad`
6. Crea/actualiza el tercero en HGI:
   - Log:
     - `logger.stepInfo('Creando o actualizando tercero en HGI...')`
   - Llama:
     - `await crearOActualizarTercero(terceroData)`
   - Nota: aquí es donde entra el wrapper de HGI con token/retry.
7. Bloques de FAC y detalles:
   - En este momento, **la creación del encabezado FAC** (`crearEncabezadoFAC`) y **los detalles** (`crearDetalleFAC`) están **deshabilitados** en el flujo actual:
     - están comentados en `orderService.processOrder`.
8. Retorna el JSON final:
   - No retorna `orden_numero`, `numeroDoc`, etc. (porque esas líneas también están comentadas).
   - Retorna un objeto “mezclado”:
     - `...docData`, `...terceroData`, `...items`

Importante: ese “spread” mezcla campos del tercero y del documento con los campos de `items` (tal como está implementado hoy). Ese es exactamente el objeto que el controller responde como JSON.

---

## 4. Mapeo de Shopify a HGI: `mapearOrdenShopifyParaHGI(order)`

Archivo: `src/mappers/shopifyToHgi.js`.

Se ejecuta desde `processOrder`.

1. Inicializa variables:
   - `customer`, `shipping`, `billing` a partir del `order`.
2. Calcula `numeroIdentificacion`:
   - Toma:
     - `order.shipping_address?.company` como preferencia
     - si no existe, usa `order.billing_address?.company`
     - si sigue sin existir, usa `String(customer.id ?? '')`
   - Luego hace `.trim()`.
3. Construye `terceroData`:
   - `numeroIdentificacion`: calculado
   - `nombre`: concatena `customer.first_name` + `customer.last_name`, si faltan usa `Cliente Shopify`
   - `direccion`: `shipping.address1 ?? ''`
   - `telefono`: `shipping.phone ?? billing.phone ?? ''`
   - `email`: `order.contact_email ?? ''`
   - `ciudad`: `shipping.city ?? ''`
4. Calcula fecha:
   - `createdAt` desde `order.created_at` o `new Date()` si no viene.
5. Construye `docData`:
   - `numeroDocumento`: `'SHOP-' + order.order_number`
   - `fecha`: `formatoFecha(order.created_at)`
   - `ano`, `periodo`
   - `total`: `parseFloat(order.total_price) || 0`
   - `observaciones`: concatena orden # y email
   - `numeroIdentificacion`: igual al del tercero
6. Construye `items`:
   - Recorre `order.line_items || []`
   - Por cada ítem:
     - extrae `sku`
     - si `sku === ''`, lo omite (loguea el omitido)
     - si tiene sku, agrega `{ sku, cantidad: item.quantity, nombre: item.title ?? item.name ?? '' }`
7. Retorna:
   - `{ terceroData, docData, items }`

---

## 5. Cache de ciudades: `hgiCacheService.obtenerCodigoCiudad(ciudad)`

Archivo: `src/services/hgiCacheService.js`.

Este servicio depende de una carga inicial que corre en el arranque:
- `app.init()` llama `hgiCacheService.inicializarCache()`
- `src/app.js` → `await hgiCacheService.inicializarCache()`

### 5.1 Inicialización de cache (cuando arranca la app)

En `hgiCacheService.inicializarCache()`:
1. Siempre carga ciudades desde `data/ciudad/ciudad.json` (preferido):
   - `cargarCiudades()`
2. Construye:
   - `ciudadesMap`: `clave_normalizada -> codigo`
   - `fuseCiudades`: índice fuzzy sobre las keys normalizadas (umbral `0.4`)
   - `cacheCodigoCiudad`: se limpia
3. Luego, si `HGI_BASE_URL` existe:
   - carga productos desde endpoint HGI (`/Api/Productos/ObtenerProductos`) usando `hgiRequest`

### 5.2 Lookup en ejecución: `obtenerCodigoCiudad`

Cuando el endpoint llega y entra a:
- `hgiCacheService.obtenerCodigoCiudad(terceroData.ciudad)`

funciona así:

1. Valida vacío:
   - si `nombreCiudad == null` o `trim()===''` → lanza `Error('Ciudad no encontrada en HGI: (vacío)')`
2. Normaliza el input:
   - `normalizarNombreCiudad(nombre)`:
     1. `trim()`
     2. quitar tildes con `normalize('NFD')` + remover `[\u0300-\u036f]`
     3. colapsar espacios con `.replace(/\s+/g, ' ')`
     4. `toUpperCase()`
3. Cache O(1) por nombre normalizado:
   - si `cacheCodigoCiudad.has(clave)`:
     - si el valor cacheado `!= null`, lo devuelve
     - si está en cache `null`, lanza el error “ciudad no encontrada”
4. Match exacto:
   - intenta `ciudadesMap.get(clave)`
   - si existe:
     - lo guarda en `cacheCodigoCiudad` y lo devuelve
5. Match fuzzy:
   - si no hay exact match y `fuseCiudades` existe:
     - `fuseCiudades.search(clave)`
     - toma el mejor candidato
     - traduce candidate key a su código usando `ciudadesMap.get(mejorKey)`
6. Guarda en cache:
   - `cacheCodigoCiudad.set(clave, codigoFuzzy)`
   - si `codigoFuzzy != null`, devuelve; si no, lanza

---

## 6. Crear/Actualizar tercero: `crearOActualizarTercero(terceroData)`

Archivo: `src/services/hgiTerceroService.js`.

Se ejecuta desde `orderService.processOrder()` y es el punto crítico de token/retry.

1. Construye `payload` como un array con un solo objeto:
   - `NumeroIdentificacion` (desde `terceroData.numeroIdentificacion`)
   - `Nombre` (terceroData.nombre)
   - `Direccion`, `CodigoCiudad`, `Telefono`, `Email`
   - `CodigoTipoTercero`, `CodigoVendedor`, `CodigoSucursal`, `CodigoCausaRetiro` (hardcodeado)
2. Arma la URL:
   - `base = (config.hgi?.baseUrl || '').replace(/\/$/, '')`
   - `url = `${base}/Api/Terceros/Crear``
3. Ejecuta la llamada HGI con el wrapper con token:
   - `const { data } = await hgiRequest({ method: 'post', url, headers, data: payload })`

Luego interpreta la respuesta:
1. Toma el primer elemento:
   - `const first = Array.isArray(data) ? data[0] : data`
2. Revisa `first?.Error`:
   - Si `err == null`:
     - loguea “tercero creado/actualizado …” y retorna
   - Si existe error:
     - `mensaje = err.Mensaje ?? err.mensaje ?? String(err)`
3. Si el mensaje contiene:
   - `'ya se encuentra registrado'`
   - loguea “tercero ya registrado …” y retorna
4. Si no es ese caso:
   - lanza `throw new Error(mensaje)`

---

## 7. Wrapper HGI con token y retry: `hgiRequest(axiosRequestConfig)`

Archivo: `src/services/hgiAuthService.js`.

Este wrapper es el que implementa tu lógica:
- token en memoria (runtime) cargado desde `data/CONSTANTS.txt` la primera vez que se usa
- en caso de falla llama auth (`/Api/Autenticar`)
- actualiza `data/CONSTANTS.txt` y la capa en memoria cuando el auth es exitoso
- protege concurrencia con `authInFlight` (solo 1 request refresh a la vez)
- si el auth devuelve token vacío, re-lee `data/CONSTANTS.txt` hasta 3 veces con 300ms de espera

### 7.1 Ciclo de intentos

`hgiRequest` hace:
1. Preparación:
   - crea `baseConfig` a partir de `axiosRequestConfig`
2. Ejecuta un loop `for (let i = 0; i < 2; i++)` (máximo **2 intentos por petición**):
   - intento 1: con el token leído de `data/CONSTANTS.txt`
   - intento 2: si se marcó `refreshed=true` (o si se detectó token inválido y se refrescó), reintenta la misma llamada ya con el token actualizado

En cada intento:
1. Obtiene `storedToken` desde memoria (capa runtime)
   - si la memoria aún no está cargada, se inicializa una sola vez leyendo `data/CONSTANTS.txt`
   - `TOKEN=null` o `TOKEN=""` se normaliza a `""`
2. Si `storedToken` está vacío:
   - Si `retryOnAuthFailure` está activo:
     - llama `refreshTokenFromHgiAndStore()`
     - marca `refreshed = true`
     - continúa al siguiente intento
3. Si hay token:
   - (TTL proactivo) Si el JWT trae claim `exp` y el token vence “pronto” (margen de 2 min), **refresca antes de llamar a HGI** con `refreshTokenFromHgiAndStore()`.
   - Finalmente ejecuta `axios(...)` con:
     - `Authorization: Bearer ${storedToken}`
   - Loguea duración:
     - `HGI: request ok en Xms (...)`

### 7.2 Detección de token inválido

Si la respuesta retorna y el payload indica fallo de auth:
- usa `isAuthFailurePayload(res.data)`

Si el `axios` lanza error:
- usa `isAuthFailureAxiosError(err)`

Incluye este caso reportado:
- `400 Invalid token` (a veces sin body)

### 7.3 Refresh: `refreshTokenFromHgiAndStore()`

Cuando toca refresh:
1. Protege concurrencia dentro del proceso con `authInFlight`
2. Ejecuta `fetchTokenFromHgi(0)`:
   - hace `axios.get` a:
     - `${baseUrl}/Api/Autenticar`
   - manda credenciales por `params`:
     - `usuario`, `clave`, `cod_compania`, `cod_empresa`
3. Extrae el token desde la respuesta:
   - `data?.JwtToken ?? data?.Token ?? data?.token ?? data?.access_token`
4. Escribe el token en `data/CONSTANTS.txt`:
   - reemplaza la línea `TOKEN=...` (o la agrega)
   - usa archivo temporal y `renameSync` para minimizar corrupción del archivo

5. Manejo de escenarios de falla:
   - si `/Api/Autenticar` falla (red/timeout/exception), NO invalida el token que ya estaba en memoria
   - aplica un cooldown de ~15s para evitar llamar auth una y otra vez si HGI está caído

#### 7.3.1 Reintentos dentro de la llamada de auth (`fetchTokenFromHgi`)

`fetchTokenFromHgi()` maneja especialmente:
- `data.Error.Codigo === 3`

Ese caso significa que HGI te dice: **“el Token aún se encuentra vigente para el usuario admin”** y por eso el `JwtToken` viene `null`.

Decisión tomada por tu problema original (evitar “perder el bueno”):
1. En vez de esperar 21s y reintentar auth (lo cual puede dejarte sin token válido si el refresh no devuelve nada),
2. `fetchTokenFromHgi` hace un “no-op”:
   - si ya existe `tokenMemory`, devuelve ese token
   - si no existe en memoria aún, intenta leerlo desde `data/CONSTANTS.txt`
3. si aun así no hay token disponible, retorna `""` para que el caller re-lea `data/CONSTANTS.txt`.

Regla especial que pediste:
- Si el token obtenido por auth es `null` o `""`:
  - re-leer `data/CONSTANTS.txt` hasta 3 veces
  - espera 300ms entre relecturas
  - esto permite que otra request concurrente ya haya resuelto el token

### 7.4 Reintento

Después del refresh:
- `hgiRequest` reintenta la misma petición HGI desde el loop (hasta contemplar la segunda ronda).

---

## 8. Servicios existentes pero no ejecutados en este flujo actual

En este endpoint, tal como está el código vigente hoy:

1. `crearEncabezadoFAC` y `crearDetalleFAC` están importados desde `src/services/hgiDocumentService.js`, pero **no se ejecutan** porque en `orderService.processOrder` están comentados:
   - no se llama a `crearEncabezadoFAC(docData)`
   - no se llama a `crearDetalleFAC(numeroDoc, item, ...)`
2. `forwardToExternalApi` existe en `orderService.js`, pero tampoco se llama desde `processOrder`.
3. `validatePayload` existe en `orderService.js`, pero no se usa en el flujo de `processOrder`.
4. `buildPayload` existe, pero tampoco se usa desde `processOrder` en este flujo.

Estos puntos son importantes porque, aunque “existan servicios”, el flujo real del endpoint solo invoca los que están activos y no comentados.

---

## 9. ¿Qué regresa el endpoint?

Finalmente:

- `webhookController.handleOrderCompleted` devuelve:
  - `res.status(200).json(result)`
- donde `result` es exactamente el objeto retornado por:
  - `orderService.processOrder(req.body)`

En la implementación actual ese objeto contiene:
- `...docData`
- `...terceroData`
- `...items`

---

## 10. Resumen ultra corto del grafo de llamadas

`POST /webhook/order-completed`
→ `webhookController.handleOrderCompleted`
→ `orderService.processOrder`
→ `mapearOrdenShopifyParaHGI`
→ `hgiCacheService.obtenerCodigoCiudad` (cache + normalización + fuzzy)
→ `hgiTerceroService.crearOActualizarTercero`
→ `hgiAuthService.hgiRequest` (token desde `data/CONSTANTS.txt` + retry)
→ (posible `hgiAuthService.refreshTokenFromHgiAndStore` → `fetchTokenFromHgi`)
→ respuesta HGI interpretada por `crearOActualizarTercero`
→ controller responde JSON.

