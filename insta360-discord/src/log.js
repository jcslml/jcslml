// Registro por consola con hora y nivel.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MARKS = { debug: '·', info: ' ', warn: '!', error: '✖' };

/** @returns {(level: 'debug'|'info'|'warn'|'error', message: string) => void} */
export function createLogger(minLevel = process.env.LOG_LEVEL ?? 'info') {
  const threshold = LEVELS[minLevel] ?? LEVELS.info;
  return (level, message) => {
    if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
    const time = new Date().toLocaleTimeString('es-ES', { hour12: false });
    const line = `${time} ${MARKS[level] ?? ' '} ${message}`;
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };
}
