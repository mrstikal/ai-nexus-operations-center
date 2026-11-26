import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  RunDetailSchema,
  RunEventsPageSchema,
  RunEventsQuerySchema,
  UuidSchema,
  type RunDetail,
  type RunEventsPage,
  type RunEvent,
} from '@nexus/contracts';
import type { RunQueryService } from '@nexus/application/workflows/queries';
import type { AuthenticatedSession } from '@nexus/application/identity/sessions';
import { ProblemException } from '../errors.js';
import { SessionAuthGuard } from '../auth/guards.js';
import { NEXUS_RUN_QUERY } from './tokens.js';

const DEFAULT_PAGE_SIZE = 100;
const MAX_BUFFER_BYTES = 1_048_576;

export interface RunQueryServices {
  readonly service: RunQueryService;
}

interface AuthedRequest extends Request {
  auth?: AuthenticatedSession;
}

function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function eventLastId(request: Request, after: number | undefined): number {
  const header = request.headers['last-event-id'];
  const raw = Array.isArray(header) ? header[0] : header;
  const value = raw ?? (after === undefined ? undefined : String(after));
  if (value === undefined) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw new ProblemException('VALIDATION_FAILED', 'Last-Event-ID is invalid');
  }
  return parsed;
}

function parseQuery(query: unknown): { after: number | undefined; limit: number | undefined } {
  try {
    const parsed = RunEventsQuerySchema.parse(query);
    return { after: parsed.after, limit: parsed.limit };
  } catch {
    throw new ProblemException('VALIDATION_FAILED', 'Event query is invalid');
  }
}

function waitForDrain(
  response: Response,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      response.off('drain', onDrain);
      response.off('close', onClose);
    };
    const onDrain = (): void => {
      cleanup();
      resolve(true);
    };
    const onClose = (): void => {
      cleanup();
      resolve(false);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    response.once('drain', onDrain);
    response.once('close', onClose);
  });
}

@Controller('api/v1')
export class RunQueryController {
  constructor(
    @Inject(NEXUS_RUN_QUERY)
    private readonly services: RunQueryServices | null,
  ) {}

  private requireServices(): RunQueryServices {
    if (!this.services) {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Run read storage is unavailable',
      );
    }
    return this.services;
  }

  private async sandboxId(service: RunQueryService): Promise<string> {
    let sandboxId: string | null;
    try {
      sandboxId = await service.getActiveSandboxId();
    } catch {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Run read storage is unavailable',
      );
    }
    if (!sandboxId) {
      throw new ProblemException('STALE_STATE', 'No active sandbox is available');
    }
    return sandboxId;
  }

  private requireRunId(runId: string): string {
    if (!UuidSchema.safeParse(runId).success) {
      throw new ProblemException('VALIDATION_FAILED', 'Run ID is invalid');
    }
    return runId;
  }

  private async readDetail(
    service: RunQueryService,
    sandboxId: string,
    runId: string,
  ): Promise<RunDetail | null> {
    try {
      return await service.getDetail(sandboxId, runId);
    } catch {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Run read storage is unavailable',
      );
    }
  }

  @Get('runs/:runId')
  @UseGuards(SessionAuthGuard)
  async detail(@Param('runId') runId: string): Promise<RunDetail> {
    const { service } = this.requireServices();
    const id = this.requireRunId(runId);
    const sandboxId = await this.sandboxId(service);
    const detail = await this.readDetail(service, sandboxId, id);
    if (!detail) {
      throw new ProblemException('NOT_FOUND', 'Run was not found');
    }
    return RunDetailSchema.parse(detail);
  }

  @Get('runs/:runId/events/page')
  @UseGuards(SessionAuthGuard)
  async eventsPage(
    @Param('runId') runId: string,
    @Query() query: unknown,
  ): Promise<RunEventsPage> {
    const { service } = this.requireServices();
    const id = this.requireRunId(runId);
    const sandboxId = await this.sandboxId(service);
    const detail = await this.readDetail(service, sandboxId, id);
    if (!detail) {
      throw new ProblemException('NOT_FOUND', 'Run was not found');
    }
    const parsed = parseQuery(query);
    let page: RunEventsPage;
    try {
      page = await service.listEvents(
        sandboxId,
        id,
        parsed.after ?? 0,
        parsed.limit ?? DEFAULT_PAGE_SIZE,
      );
    } catch {
      throw new ProblemException(
        'DEPENDENCY_UNAVAILABLE',
        'Run read storage is unavailable',
      );
    }
    return RunEventsPageSchema.parse(page);
  }

  @Get('runs/:runId/events')
  @UseGuards(SessionAuthGuard)
  async events(
    @Req() request: AuthedRequest,
    @Res() response: Response,
    @Param('runId') runId: string,
    @Query() query: unknown,
  ): Promise<void> {
    const { service } = this.requireServices();
    const id = this.requireRunId(runId);
    const sandboxId = await this.sandboxId(service);
    const detail = await this.readDetail(service, sandboxId, id);
    if (!detail) {
      throw new ProblemException('NOT_FOUND', 'Run was not found');
    }
    const parsed = parseQuery(query);
    let lastId = eventLastId(request, parsed.after);

    const pollMs = integerSetting('NEXUS_SSE_POLL_MS', 500, 10, 60_000);
    const heartbeatMs = integerSetting(
      'NEXUS_SSE_HEARTBEAT_MS',
      15_000,
      10,
      60_000,
    );
    const maxBuffer = integerSetting(
      'NEXUS_SSE_MAX_BUFFER_BYTES',
      MAX_BUFFER_BYTES,
      64,
      16 * 1_048_576,
    );
    let closed = false;
    let pumpInFlight = false;
    let poll: NodeJS.Timeout | null = null;
    let heartbeat: NodeJS.Timeout | null = null;

    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      if (poll !== null) {
        clearInterval(poll);
      }
      if (heartbeat !== null) {
        clearInterval(heartbeat);
      }
      if (!response.writableEnded) {
        response.end();
      }
    };

    request.on('close', close);
    response.on('close', close);

    const send = async (event: RunEvent): Promise<boolean> => {
      if (closed) {
        return false;
      }
      if (response.writableLength > maxBuffer) {
        close();
        return false;
      }
      const chunk = `id: ${event.id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
      if (response.write(chunk)) {
        return true;
      }
      if (await waitForDrain(response, 5_000)) {
        return true;
      }
      close();
      return false;
    };

    const pump = async (): Promise<boolean> => {
      if (pumpInFlight || closed) {
        return !closed;
      }
      pumpInFlight = true;
      try {
        while (!closed) {
          const page = await service.listEvents(
            sandboxId,
            id,
            lastId,
            DEFAULT_PAGE_SIZE,
          );
          if (closed) {
            return false;
          }
          for (const event of page.items) {
            if (!(await send(event))) {
              return false;
            }
            lastId = event.id;
          }
          if (page.nextAfter !== null && page.nextAfter > lastId) {
            lastId = page.nextAfter;
          }
          if (!page.hasMore) {
            return true;
          }
        }
        return false;
      } finally {
        pumpInFlight = false;
      }
    };

    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();
    response.write(': connected\n\n');
    let replayed: boolean;
    try {
      replayed = await pump();
    } catch {
      close();
      return;
    }
    if (!replayed || closed) {
      return;
    }
    poll = setInterval(() => {
      if (!closed) {
        void pump().catch(() => close());
      }
    }, pollMs);
    heartbeat = setInterval(() => {
      if (!closed && response.writableLength <= maxBuffer) {
        response.write(': heartbeat\n\n');
      }
    }, heartbeatMs);
  }
}
