import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  EnterpriseCommandReceiptSchema,
  EnterpriseReceiptKeySchema,
  type EnterpriseCommandReceipt,
} from '@nexus/contracts';
import type { Pool } from 'pg';
import {
  ENTERPRISE_DB_POOL,
  EnterpriseCommandGuard,
  ProblemException,
  type EnterpriseRequest,
} from './auth.js';
import { loadReceiptByKey } from './commands/transaction.js';

@Controller('v1/command-receipts')
@UseGuards(EnterpriseCommandGuard)
export class ReceiptController {
  constructor(@Inject(ENTERPRISE_DB_POOL) private readonly pool: Pool) {}

  @Get(':idempotencyKey')
  @Header('Cache-Control', 'no-store')
  async receipt(
    @Param('idempotencyKey') idempotencyKey: string,
    @Req() request: EnterpriseRequest,
  ): Promise<EnterpriseCommandReceipt> {
    const parsed = EnterpriseReceiptKeySchema.safeParse(idempotencyKey);
    if (!parsed.success) {
      throw new ProblemException(
        'VALIDATION_FAILED',
        'Invalid command receipt key',
      );
    }
    const context = request.enterpriseContext;
    if (!context) {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Sandbox context is unavailable',
      );
    }
    const receipt = await loadReceiptByKey(
      this.pool,
      context.sandboxId,
      parsed.data,
    );
    if (!receipt) {
      throw new ProblemException('NOT_FOUND', 'Command receipt was not found');
    }
    return EnterpriseCommandReceiptSchema.parse(receipt);
  }
}
