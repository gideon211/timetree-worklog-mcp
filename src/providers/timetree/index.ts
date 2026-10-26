import type { AppConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { CommunityTimeTreeProvider } from './community.js';
import { MockTimeTreeProvider } from './mock.js';
import type { TimeTreeProvider } from './provider.js';

export function createTimeTreeProvider(
  config: AppConfig,
  logger: Logger,
  options: { fetchImpl?: typeof fetch; mock?: MockTimeTreeProvider } = {},
): TimeTreeProvider {
  if (config.provider === 'mock') {
    return options.mock ?? new MockTimeTreeProvider();
  }
  return new CommunityTimeTreeProvider({
    config,
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

export { CommunityTimeTreeProvider, MockTimeTreeProvider };
export type {
  CreateMemoInput,
  ProviderCalendar,
  ProviderHealth,
  ProviderMemo,
  TimeTreeProvider,
} from './provider.js';
export { ProviderError } from './provider.js';
