import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  EnterpriseCommandKindSchema,
  EnterpriseCommandRequestSchema,
  type EnterpriseCommandKind,
  type EnterpriseCommandReceipt,
} from '@nexus/contracts';
import type { Pool } from 'pg';
import type { z } from 'zod';
import {
  ENTERPRISE_DB_POOL,
  EnterpriseCommandGuard,
  ProblemException,
  type EnterpriseRequest,
} from './auth.js';
import { executeCreatePurchaseOrder } from './commands/create-purchase-order.js';
import { executeSendMessage } from './commands/send-message.js';
import { runCommandTransaction } from './commands/transaction.js';

function validationProblem(error: z.ZodError): ProblemException {
  return new ProblemException(
    'VALIDATION_FAILED',
    'Invalid command request',
    error.issues.map((issue) => ({
      path: issue.path.map((part) =>
        typeof part === 'symbol' ? String(part) : part,
      ),
      message: issue.message,
      code: issue.code,
    })),
  );
}

@Controller('v1/commands')
@UseGuards(EnterpriseCommandGuard)
export class CommandController {
  constructor(@Inject(ENTERPRISE_DB_POOL) private readonly pool: Pool) {}

  @Post(':kind')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async execute(
    @Param('kind') kindValue: string,
    @Body() body: unknown,
    @Req() request: EnterpriseRequest,
  ): Promise<EnterpriseCommandReceipt> {
    const kind = EnterpriseCommandKindSchema.safeParse(kindValue);
    if (!kind.success) {
      throw new ProblemException('NOT_FOUND', 'Unsupported enterprise command kind');
    }
    const parsed = EnterpriseCommandRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw validationProblem(parsed.error);
    }
    const context = request.enterpriseContext;
    if (!context) {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Sandbox context is unavailable',
      );
    }
    if (parsed.data.sandboxId.toLowerCase() !== context.sandboxId) {
      throw new ProblemException(
        'FORBIDDEN',
        'Command sandbox does not match the sandbox header',
      );
    }
    if (parsed.data.payloadTemplate.kind !== kind.data) {
      throw new ProblemException(
        'VALIDATION_FAILED',
        'Command route kind does not match payloadTemplate.kind',
      );
    }

    const commandKind: EnterpriseCommandKind = kind.data;
    return runCommandTransaction(
      this.pool,
      {
        sandboxId: context.sandboxId,
        correlationId: context.correlationId,
        kind: commandKind,
        request: parsed.data,
      },
      async (commandContext) => {
        if (parsed.data.payloadTemplate.kind === 'enterprise.create_purchase_order') {
          return executeCreatePurchaseOrder(
            commandContext,
            parsed.data.payloadTemplate,
          );
        }
        return executeSendMessage(commandContext, parsed.data.payloadTemplate);
      },
    );
  }
}
