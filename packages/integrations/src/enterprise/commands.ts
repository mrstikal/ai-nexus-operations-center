import type { EnterpriseCommandPort } from '@nexus/application/ports/enterprise';
import { EnterpriseCommandHttpClient } from './client.js';

export interface EnterpriseCommandEnvironment {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs?: number;
}

export function enterpriseCommandEnvironmentFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EnterpriseCommandEnvironment {
  const baseUrl = env['ENTERPRISE_SIM_BASE_URL'];
  const token = env['ENTERPRISE_SIM_COMMAND_TOKEN'];
  if (typeof baseUrl !== 'string' || baseUrl === '' || typeof token !== 'string' || token === '') {
    throw new Error('Enterprise simulator command URL/token are not configured');
  }
  return { baseUrl, token };
}

export function createEnterpriseCommandPort(
  env: NodeJS.ProcessEnv = process.env,
): EnterpriseCommandPort {
  const config = enterpriseCommandEnvironmentFromEnv(env);
  return new EnterpriseCommandHttpClient(config);
}
