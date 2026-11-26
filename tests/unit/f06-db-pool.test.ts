import { describe, expect, it, vi } from 'vitest';
import { createNexusPool } from '../../packages/db/src/connection.js';

describe('nexus database pool error handling', () => {
  it('handles an idle client error without throwing and logs only the error code', async () => {
    const pool = createNexusPool('api', {
      NEXUS_DB_HOST: '127.0.0.1',
      NEXUS_DB_PORT: '1',
      NEXUS_DB_NAME: 'nexus',
      NEXUS_API_DB_USER: 'nexus_api',
      NEXUS_API_DB_PASSWORD: 'test-only-password',
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const error = Object.assign(new Error('terminating connection'), { code: '57P01' });
      expect(() => {
        pool.emit('error', error);
      }).not.toThrow();
      expect(errorLog).toHaveBeenCalledWith('Nexus PostgreSQL pool idle client error (57P01)');
      expect(errorLog.mock.calls.flat().join(' ')).not.toContain('test-only-password');
    } finally {
      errorLog.mockRestore();
      await pool.end();
    }
  });
});
