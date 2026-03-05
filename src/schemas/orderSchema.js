const Joi = require('joi');

const clienteSchema = Joi.object({
  id: Joi.alternatives().try(Joi.number(), Joi.string()).optional().allow(null),
  nombre: Joi.string().optional().allow('', null),
  email: Joi.string().email().optional().allow('', null),
  telefono: Joi.string().optional().allow('', null),
}).optional();

const envioSchema = Joi.object({
  nombre: Joi.string().optional().allow('', null),
  direccion: Joi.string().optional().allow('', null),
  ciudad: Joi.string().optional().allow('', null),
  pais: Joi.string().optional().allow('', null),
}).optional();

const productoSchema = Joi.object({
  producto_id: Joi.alternatives().try(Joi.number(), Joi.string()).required(),
  variante_id: Joi.alternatives().try(Joi.number(), Joi.string()).required(),
  nombre: Joi.string().required(),
  sku: Joi.string().optional().allow('', null),
  cantidad: Joi.number().integer().min(1).required(),
  precio_unit: Joi.string().required(),
  total: Joi.string().required(),
});

const descuentoSchema = Joi.object({
  codigo: Joi.string().required(),
  valor: Joi.string().required(),
  tipo: Joi.string().required(),
});

const payloadSchema = Joi.object({
  orden_id: Joi.alternatives().try(Joi.number(), Joi.string()).required(),
  orden_numero: Joi.alternatives().try(Joi.number(), Joi.string()).required(),
  fecha: Joi.string().required(),
  total: Joi.string().required(),
  subtotal: Joi.string().required(),
  moneda: Joi.string().required(),
  estado_pago: Joi.string().required(),
  estado_envio: Joi.alternatives().try(Joi.string(), Joi.valid(null)).required(),
  cliente: clienteSchema,
  envio: envioSchema,
  productos: Joi.array().items(productoSchema).required(),
  descuentos: Joi.array().items(descuentoSchema).optional(),
});

function validatePayload(payload) {
  return payloadSchema.validate(payload, { stripUnknown: true });
}

module.exports = { payloadSchema, validatePayload };
