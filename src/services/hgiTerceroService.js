const config = require('../config');
const logger = require('./logger');
const { hgiRequest } = require('./hgiAuthService');

const base = (config.hgi?.baseUrl || '').replace(/\/$/, '');

function construirTercero(terceroData) {
  const t = config.hgi.tercero;
  return {
    NumeroIdentificacion: terceroData.numeroIdentificacion,
    TipoIdentificacion: t.tipoIdentificacion,
    CodigoTipoPersona: t.codigoTipoPersona,
    Nombre: terceroData.nombre,
    Nombre1: terceroData.nombre1 ?? '',
    Nombre2: terceroData.nombre2 ?? '',
    Apellido1: terceroData.apellido1 ?? '',
    Apellido2: terceroData.apellido2 ?? '',
    Direccion: terceroData.direccion ?? '',
    DireccionAlterna: terceroData.direccionAlterna ?? '',
    CodigoCiudad: terceroData.codigoCiudad ?? '',
    CodigoBarrio: '0',
    CodigoSector: '0',
    Telefono: terceroData.telefono ?? '',
    Celular: terceroData.celular ?? '',
    Email: terceroData.email ?? '',
    EmailFacturaElectronica: terceroData.email ?? '',
    CodigoTipoTercero: t.codigoTipoTercero,
    CodigoVendedor: t.codigoVendedor,
    CodigoSucursal: t.codigoSucursal,
    CodigoCausaRetiro: t.codigoCausaRetiro,
    Estado: 1,
  };
}

function extraerMensajeError(data) {
  const first = Array.isArray(data) ? data[0] : data;
  const err = first?.Error;
  if (err == null) return null;
  return err.Mensaje ?? err.mensaje ?? String(err);
}

/**
 * Crear/Actualizar devuelven el Tercero tal como quedó en HGI (manual §4.12.8-9).
 * Un campo enviado con valor que vuelve vacío o no vuelve indica que HGI no lo
 * reconoce con ese nombre; se deja en el log para corregirlo sin acceso directo a HGI.
 */
function reportarCamposNoGuardados(metodo, enviado, data) {
  const devuelto = Array.isArray(data) ? data[0] : data;
  if (!devuelto || typeof devuelto !== 'object') return;
  const ignorados = Object.entries(enviado)
    .filter(([, valor]) => valor !== '' && valor != null)
    .filter(([campo]) => devuelto[campo] === undefined || devuelto[campo] === null || devuelto[campo] === '')
    .map(([campo]) => campo);
  if (ignorados.length > 0) {
    logger.stepErr(`HGI Terceros/${metodo}: campos enviados que HGI no devolvió: ${ignorados.join(', ')}`);
  }
  logger.payload(`HGI Terceros/${metodo} respuesta`, data);
}

async function enviarTercero(metodo, payload) {
  const { data } = await hgiRequest({
    method: 'post',
    url: `${base}/Api/Terceros/${metodo}`,
    headers: { 'Content-Type': 'application/json' },
    data: payload,
  });
  const mensajeError = extraerMensajeError(data);
  if (mensajeError == null) reportarCamposNoGuardados(metodo, payload[0], data);
  return mensajeError;
}

async function crearOActualizarTercero(terceroData) {
  const payload = [construirTercero(terceroData)];
  const id = terceroData.numeroIdentificacion;

  const errorCrear = await enviarTercero('Crear', payload);
  if (errorCrear == null) {
    logger.stepOk(`HGI: tercero creado ${id}`);
    return;
  }
  if (!errorCrear.toLowerCase().includes('ya se encuentra registrado')) {
    throw new Error(errorCrear);
  }

  // El tercero ya existe: se actualiza para que HGI tenga los datos de esta compra.
  // Un fallo aquí no bloquea la factura (el tercero ya existe y es válido para facturar).
  try {
    const errorActualizar = await enviarTercero('Actualizar', payload);
    if (errorActualizar == null) {
      logger.stepOk(`HGI: tercero actualizado ${id}`);
    } else {
      logger.stepErr(`HGI: no se pudo actualizar el tercero ${id}: ${errorActualizar}`);
    }
  } catch (error) {
    logger.stepErr(`HGI: no se pudo actualizar el tercero ${id}: ${error.message}`);
  }
}

module.exports = {
  crearOActualizarTercero,
};
