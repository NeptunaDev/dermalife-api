const config = require('../config');
const logger = require('./logger');
const { hgiRequest } = require('./hgiAuthService');

const base = (config.hgi?.baseUrl || '').replace(/\/$/, '');

async function crearOActualizarTercero(terceroData) {
  const payload = [
    {
      NumeroIdentificacion: terceroData.numeroIdentificacion,
      Nombre: terceroData.nombre,
      Direccion: terceroData.direccion ?? '',
      CodigoCiudad: terceroData.codigoCiudad ?? '',
      Telefono: terceroData.telefono ?? '',
      Email: terceroData.email ?? '',
      CodigoTipoTercero: '10',
      CodigoVendedor: '51',
      CodigoSucursal: '1',
      CodigoCausaRetiro: '0',
    },
  ];

  const url = `${base}/Api/Terceros/Crear`;
  const { data } = await hgiRequest({
    method: 'post',
    url,
    headers: { 'Content-Type': 'application/json' },
    data: payload,
  });

  const first = Array.isArray(data) ? data[0] : data;
  const err = first?.Error;
  if (err == null) {
    logger.stepOk(`HGI: tercero creado/actualizado ${terceroData.numeroIdentificacion}`);
    return;
  }
  const mensaje = err.Mensaje ?? err.mensaje ?? String(err);
  if (mensaje.toLowerCase().includes('ya se encuentra registrado')) {
    logger.stepOk(`HGI: tercero ya registrado ${terceroData.numeroIdentificacion}`);
    return;
  }
  throw new Error(mensaje);
}

module.exports = {
  crearOActualizarTercero,
};
