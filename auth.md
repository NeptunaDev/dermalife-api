# Auth HGI (token, refresh, reintentos y concurrencia)

Este documento describe el flujo de autenticación que usa la API para comunicarse con HGI, cómo maneja tokens inválidos/expirados y qué decisiones toma para no “perder” el token bueno cuando hay concurrencia.

Se implementa principalmente en `src/services/hgiAuthService.js` y se usa indirectamente desde el endpoint `POST /webhook/order-completed`.

---

## 1) Problema que se está resolviendo

HGI utiliza un token (JWT) para autorizar requests. En producción pueden ocurrir casos como:

1. **El token expira** y HGI responde error de autenticación (ej. `400 Invalid token` o `401/403`).
2. **Dos requests simultáneas** detectan el token inválido o “no vigente” al mismo tiempo.
3. El endpoint de refresh (`/Api/Autenticar`) puede responder que el token aún está vigente:
   - `JwtToken: null`
   - `Error.Codigo: 3`
   - `Error.Mensaje: "El Token aún se encuentra vigente para el usuario admin."`

Si el refresh se ejecuta “antes de tiempo”, o si varias requests refrescan a la vez, existe el riesgo de que el sistema:
- espere innecesariamente,
- intente reescribir el token con `null/""`,
- o termine con un refresh fallido dejando el token “en mal estado”, causando reintentos en bucle y latencia.

---

## 2) Dónde se guarda el token (DB + memoria) y cómo se usa

El token se guarda principalmente en SQLite (en el mismo archivo de DB que ya usa el sistema de persistencia de órdenes):

- `API/data/orders.db`
- Tabla: `hgi_token`

Esquema:
- `id` (siempre 1)
- `token` (JWT)
- `obtenido_at` / `updated_at`

Durante runtime existe además una caché en memoria (para performance y para que el caso `Error.Codigo === 3` pueda hacer no-op sin depender del lock):
- `tokenMemory`

`API/data/CONSTANTS.txt` ya no es la fuente de verdad:
- se usa solo como **bootstrap** si la fila en `hgi_token` viene vacía.
- y opcionalmente se intenta persistir ahí por compatibilidad (si el archivo existe).

---

## 3) Cuándo se ejecuta el auth

Se ejecuta cuando se hace una llamada a HGI a través del wrapper:
- `hgiRequest()` en `src/services/hgiAuthService.js`

Flujo (ruta completa):
1. `POST /webhook/order-completed` (en `src/controllers/webhookController.js`)
2. `orderService.processOrder()` (en `src/services/orderService.js`)
3. `crearOActualizarTercero()` / `crearEncabezadoFAC()` / `crearDetalleFAC()` según el flujo activo
4. Cada request a HGI usa `hgiRequest()` para aplicar token + refresh + retry.

---

## 4) Cómo funciona `hgiRequest()` (paso a paso)

Archivo: `src/services/hgiAuthService.js`

### 4.1 Ronda de intentos por request

`hgiRequest()` hace como máximo **2 intentos por request**:
1. Intento con el token actual.
2. Intento re-ejecutado después de refresh (si se detecta un error de auth y se refresca).

En cada intento:
1. Obtiene `storedToken` (en runtime principalmente; con respaldo a disco).
2. Verifica si el token debe refrescarse proactivamente.
3. Ejecuta la request con `Authorization: Bearer <token>`.
4. Si detecta que falló por auth, refresca token y reintenta.

### 4.2 TTL proactivo (antes de que falle)

El token es un JWT. El wrapper intenta decodificar el claim `exp` del JWT:
- si el token vence “pronto” (margen de 2 minutos),
- entonces refresca **antes** de llamar a HGI.

Objetivo: que el “primer fallo aleatorio” por expiración no ocurra.

Si el token no trae `exp` o no se puede decodificar, no se fuerza refresh por TTL (se deja al fallback por error de auth).

---

## 5) Cómo detecta “token inválido” y cuándo refresca

`hgiRequest()` detecta auth failure por dos vías:

1. **Cuando hay payload (`res.data`)**:
   - usa `isAuthFailurePayload(res.data)`
   - revisa estructuras `Error.Codigo` / `Error.Mensaje` del body (cuando HGI las manda).

2. **Cuando axios lanza error**:
   - usa `isAuthFailureAxiosError(err)`
   - marca `401/403`
   - y también el caso reportado: **`400 Invalid token`** aunque a veces venga sin body.

Cuando detecta auth failure:
- ejecuta `refreshTokenFromHgiAndStore()`
- y reintenta la misma request (ronda 2 del loop).

---

## 6) Refresh real: `refreshTokenFromHgiAndStore()`

### 6.1 Endpoint de refresh

El refresh usa el mismo servicio HGI:
- `GET ${HGI_BASE_URL}/Api/Autenticar`

Parámetros:
- `usuario`, `clave`, `cod_compania`, `cod_empresa`

### 6.2 Mutex real: a nivel DB (`hgi_token`)

Para concurrencia entre procesos también existe un mutex a nivel SQLite:

1. El proceso “intenta” adquirir el lock con:
   - `UPDATE hgi_token SET token='OBTENIENDO' WHERE token!='OBTENIENDO' ...`
2. Si el `UPDATE` afecta 1 fila, ese proceso es el “owner” y hace `/Api/Autenticar`.
3. Si no afecta filas, significa que otro proceso ya está refrescando:
   - el proceso espera (poll) hasta que `token` deje de ser `'OBTENIENDO'`,
   - y luego lee el token nuevo desde la tabla.

Además, para concurrencia dentro del mismo proceso se mantiene `authInFlight`:
- garantiza que solo haya un refresh activo por proceso,
- aunque el mutex de la DB ya cubra el cross-process.

---

## 7) Caso crítico: `/Api/Autenticar` responde `Error.Codigo === 3` (JwtToken null)

Este es el caso que más te preocupaba:

HGI responde:
- `JwtToken: null`
- `Error.Codigo: 3`
- “El Token aún se encuentra vigente…”

Decisión implementada:
- **No se espera 21s** ni se reintenta auth en ese caso.
- `fetchTokenFromHgi()` hace un **no-op**:
  - si `tokenMemory` existe, devuelve el token “bueno” que ya teníamos en runtime,
  - (fallback) si `tokenMemory` no está, intenta tomar el token desde la fila `hgi_token`,
  - si aun así está vacío, retorna `""`.

Por qué se toma esta decisión:
- Ese `Codigo=3` significa que no debes “perder” el token bueno.
- Refresh “demasiado temprano” no debe invalidar ni borrar el token vigente.

---

## 8) Caso crítico 2: auth devuelve token vacío (`null/""`)

Si el owner del refresh obtiene `null/""`, el comportamiento es:

- se evita “releer CONSTANTS.txt” como estrategia principal,
- en su lugar se reusa el token previo (`tokenMemory`) y/o se termina asegurando una liberación consistente del lock en `hgi_token`.

---

## 9) Caso crítico 3: auth falla durante refresh (HGI no responde)

Escenario:
- `/Api/Autenticar` falla por red/timeout/exception.

Decisión implementada:
- **no** se invalida el token que ya estaba en memoria (`tokenMemory`),
- se lanza el error a la request original (para que no siga facturando “a ciegas”),
- y se aplica un **cooldown** (~15s) para evitar llamar auth repetidamente si HGI está caído.

---

## 10) Por qué esto evita “primer fallo” y “pérdida del bueno”

Juntas, estas decisiones evitan los riesgos descritos:

1. **No se pierde** el token vigente cuando `/Api/Autenticar` responde `Codigo=3` con `JwtToken null`.
2. Concurrencia:
   - mutex `hgi_token` en SQLite evita refresh duplicado entre procesos (cross-process).
   - `authInFlight` evita refresh duplicado dentro del mismo proceso.
   - si no ganaste el lock, se hace poll hasta que el token deje de ser `'OBTENIENDO'`.
3. Proactivo:
   - TTL proactivo con `exp` reduce la probabilidad del primer error aleatorio por expiración.
4. Robustez:
   - refresh fallido no invalida el token ya existente.
   - cooldown evita bucles cuando HGI está indisponible.

---

## 11) Archivos y funciones clave

- `src/services/hgiAuthService.js`
  - `hgiRequest()` (wrapper principal: token + retry + detección)
  - `refreshTokenFromHgiAndStore()` (coordina refresh y actualización)
  - `fetchTokenFromHgi()` (llama `/Api/Autenticar` y maneja `Codigo=3`)
  - mutex: `authInFlight` (dentro del proceso)

- `src/services/hgiTokenService.js`
  - tabla `hgi_token`
  - lock cross-process: `'OBTENIENDO'` + poll

