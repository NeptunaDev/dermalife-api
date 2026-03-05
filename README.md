# Dermalife API

API que recibe webhooks de Shopify para órdenes y las reenvía a una API externa.

## Requisitos

- Node.js 18+
- Cuenta Shopify con webhooks configurados

## Instalación

```bash
npm install
cp .env.example .env
```

Configura las variables en `.env`:

| Variable | Descripción |
|----------|-------------|
| `PORT` | Puerto del servidor (default: 3000) |
| `SHOPIFY_WEBHOOK_SECRET` | Secret del webhook en Shopify |
| `API_EXTERNA_URL` | URL destino para enviar órdenes |
| `API_EXTERNA_TOKEN` | Token Bearer de autorización |

## Uso

```bash
npm start       # Producción
npm run dev     # Desarrollo (con --watch)
```

## Endpoints

- `POST /webhook/order-completed` — Webhook Shopify cuando un cliente completa una compra
- `GET /health` — Health check

## Estructura

```
src/
├── config/       # Configuración
├── controllers/  # Controladores
├── middlewares/  # HMAC Shopify
├── routes/       # Rutas
├── schemas/      # Validación
├── services/     # Lógica de negocio
├── app.js
└── index.js
```
