#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configSummary, loadConfig } from './config.js';
import { Logger } from './logger.js';
import { createMcpServer } from './mcp/tools.js';
import { createTimeTreeProvider } from './providers/timetree/index.js';
import { Ledger } from './store/ledger.js';

export async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger({ level: config.logLevel });
  logger.info('Starting timetree-worklog-mcp', { config: configSummary(config) });

  const ledger = new Ledger(config.dbPath);
  const provider = createTimeTreeProvider(config, logger);
  const bundle = createMcpServer({ config, ledger, provider, logger });
  const transport = new StdioServerTransport();

  let closing = false;
  const close = async (signal?: string) => {
    if (closing) return;
    closing = true;
    logger.info('Stopping timetree-worklog-mcp', signal ? { signal } : {});
    try {
      await bundle.server.close();
    } catch (error) {
      logger.error('Error while closing the MCP server', { error });
    }
    try {
      ledger.close();
    } catch (error) {
      logger.error('Error while closing the SQLite ledger', { error });
    }
  };

  process.once('SIGINT', () => {
    void close('SIGINT').finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void close('SIGTERM').finally(() => process.exit(0));
  });
  process.once('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    void close('uncaughtException').finally(() => process.exit(1));
  });
  process.once('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason });
    void close('unhandledRejection').finally(() => process.exit(1));
  });

  await bundle.server.connect(transport);
  logger.info('MCP server is listening on stdio', { provider: provider.name });
}

const entry = process.argv[1];
if (entry) {
  let resolvedEntry = entry;
  try {
    resolvedEntry = realpathSync(entry);
  } catch {
    // Keep the original path; the comparison below will simply not match.
  }
  const modulePath = realpathSync(fileURLToPath(import.meta.url));
  if (modulePath === resolvedEntry) {
    main().catch((error: unknown) => {
      const logger = new Logger({ level: 'error' });
      logger.error('Fatal startup error', { error });
      process.exit(1);
    });
  }
}
