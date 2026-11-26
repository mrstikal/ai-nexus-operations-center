import type { NexusDb } from '../connection.js';

export type DbTransaction = Parameters<Parameters<NexusDb['transaction']>[0]>[0];
