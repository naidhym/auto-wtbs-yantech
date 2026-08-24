import { AutoWtbApplication } from './app.js';
import { loadConfig } from './config/config.js';
import { assertSupportedNodeVersion } from './config/runtime.js';
import { installProcessHandlers } from './runtime/process-handlers.js';

async function main(): Promise<void> {
  assertSupportedNodeVersion(process.versions.node);
  const config = loadConfig();
  const application = new AutoWtbApplication(config);
  const handlers = installProcessHandlers(application);

  try {
    await application.start();
    await application.waitForShutdown();
  } finally {
    handlers.dispose();
  }
}

void main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : 'Unknown startup error';
  process.stderr.write(`Auto WTB Bot failed to start: ${reason}\n`);
  process.exitCode = 1;
});
