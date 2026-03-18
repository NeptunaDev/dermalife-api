const app = require('./app');
const config = require('./config');
const logger = require('./services/logger');

(async () => {
  try {
    await app.init();
  } catch (err) {
    logger.stepErr('Inicio: ' + (err.message || err));
  }
  app.listen(config.port, () => {
    console.log(`API escuchando en http://localhost:${config.port}`);
    if (logger.isDev) {
      console.log(`\n${logger.c.green}${logger.c.bright}▶ Modo desarrollo activo - logs detallados habilitados${logger.c.reset}\n`);
    }
  });
})();
