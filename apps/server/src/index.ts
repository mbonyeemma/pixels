import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAssistant } from './ai/index';
import { loadConfig } from './config';
import { createLogger } from './log';
import { createServer } from './server';

/** Load a .env file if present. Real environment variables always win. */
function loadDotEnv(file: string): void {
  try {
    if (existsSync(file)) process.loadEnvFile(file);
  } catch {
    /* an unreadable .env is not fatal */
  }
}

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // apps/server (src/ and dist/ are both one level below)
loadDotEnv(path.resolve(process.cwd(), '.env'));
loadDotEnv(path.resolve(serverDir, '../../.env'));

const config = loadConfig(process.env, process.cwd(), serverDir);
const log = createLogger(config.logLevel);

const assistant = createAssistant(config.ai);
const staticDir = existsSync(config.staticDir) ? config.staticDir : null;

const server = createServer({
  dataDir: config.dataDir,
  staticDir,
  assistant,
  logger: log,
  trustProxy: config.trustProxy,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  const hardExit = setTimeout(() => {
    log.error('shutdown timed out, forcing exit');
    server.db.flushSync();
    process.exit(1);
  }, 10_000);
  hardExit.unref();
  try {
    await server.stop();
  } catch (err) {
    log.error('error during shutdown', { err });
  }
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('exit', () => server.db.flushSync());
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { err });
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err }));

server
  .start(config.port)
  .then((port) => {
    const ai = assistant.describe();
    log.info('server listening', {
      port,
      dataDir: config.dataDir,
      static: staticDir ?? 'none',
      ai: `${ai.provider}${ai.model ? '/' + ai.model : ''}`,
    });
  })
  .catch((err) => {
    log.error('failed to start', { err });
    process.exit(1);
  });
