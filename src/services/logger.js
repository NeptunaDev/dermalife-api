const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'dev';
const levelName = String(process.env.LOG_LEVEL || (isDev ? 'debug' : 'info')).toLowerCase();
const LEVELS = {
  none: 0,
  error: 1,
  info: 2,
  debug: 3,
};
const currentLevel = LEVELS[levelName] ?? LEVELS.info;

function canLog(level) {
  return (LEVELS[level] ?? LEVELS.info) <= currentLevel;
}

function log(...args) {
  if (!canLog('debug')) return;
  console.log(...args);
}

function step(tag, message, extra = '') {
  const level = tag === 'ERR' ? 'error' : 'info';
  if (!canLog(level)) return;
  const tagColor = tag === 'OK' ? c.green : tag === 'ERR' ? c.red : c.cyan;
  console.log(`${c.dim}[${new Date().toISOString()}]${c.reset} ${tagColor}${c.bright}[${tag}]${c.reset} ${message}${extra ? ` ${c.dim}${extra}${c.reset}` : ''}`);
}

function stepOk(message) {
  step('OK', message);
}

function stepErr(message) {
  step('ERR', message);
}

function stepInfo(message) {
  step('→', message);
}

function section(title) {
  if (!canLog('debug')) return;
  console.log(`\n${c.magenta}${c.bright}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}`);
  console.log(`${c.magenta}${c.bright}  ${title}${c.reset}`);
  console.log(`${c.magenta}${c.bright}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
}

function payload(label, data) {
  if (!canLog('debug')) return;
  console.log(`${c.yellow}${c.bright}[${label}]${c.reset}`);
  console.log(`${c.dim}${JSON.stringify(data, null, 2)}${c.reset}\n`);
}

module.exports = {
  log,
  step,
  stepOk,
  stepErr,
  stepInfo,
  section,
  payload,
  isDev,
  levelName,
  canLog,
  c,
};
