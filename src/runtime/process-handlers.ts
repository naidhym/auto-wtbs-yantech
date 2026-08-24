import type { AutoWtbApplication } from '../app.js';

export interface ProcessHandlerRegistration {
  dispose(): void;
}

export function installProcessHandlers(
  application: AutoWtbApplication,
): ProcessHandlerRegistration {
  const handleSignal = (signal: NodeJS.Signals): void => {
    void application.shutdown(signal)
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error: unknown) => {
        process.stderr.write(`Auto WTB Bot shutdown failed: ${safeReason(error)}\n`);
        process.exitCode = 1;
      });
  };

  const handleUncaughtException = (error: Error): void => {
    void application.handleFatal(error, 'uncaught_exception')
      .catch((shutdownError: unknown) => {
        process.stderr.write(`Fatal shutdown failed: ${safeReason(shutdownError)}\n`);
      })
      .finally(() => {
        process.exit(1);
      });
  };

  const handleUnhandledRejection = (reason: unknown): void => {
    void application.handleFatal(reason, 'unhandled_rejection')
      .catch((shutdownError: unknown) => {
        process.stderr.write(`Fatal shutdown failed: ${safeReason(shutdownError)}\n`);
      })
      .finally(() => {
        process.exit(1);
      });
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  process.once('uncaughtException', handleUncaughtException);
  process.once('unhandledRejection', handleUnhandledRejection);

  return {
    dispose(): void {
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
      process.off('uncaughtException', handleUncaughtException);
      process.off('unhandledRejection', handleUnhandledRejection);
    },
  };
}

function safeReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
