const app = require('./app');
const config = require('./config');
const logger = require('./services/logger');

(async () => {
  try {
    logger.stepInfo(`Inicio: inicializando app (NODE_ENV=${process.env.NODE_ENV || 'undefined'}, LOG_LEVEL=${logger.levelName})`);
    await app.init();
    logger.stepOk('Inicio: app.init completado');
  } catch (err) {
    logger.stepErr('Inicio: ' + (err.message || err));
    logger.stepErr('Inicio abortado: no se iniciará el servidor sin products.json cargado');
    process.exit(1);
  }
  app.listen(config.port, () => {
    console.log(`API escuchando en http://localhost:${config.port}`);
    if (logger.isDev) {
      console.log(`\n${logger.c.green}${logger.c.bright}▶ Modo desarrollo activo - logs detallados habilitados${logger.c.reset}\n`);
    }
  });
})();
