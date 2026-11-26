import { Controller, Get, Module, Post, Req, UseGuards } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { ProblemFilter } from '../errors.js';
import { AuthModule } from './module.js';
import {
  Roles,
  RolesGuard,
  SessionAuthGuard,
  SessionCsrfGuard,
  type RequestLike,
} from './guards.js';

@Controller('api/v1/auth/_test')
class AuthTestController {
  @Get('read')
  @UseGuards(SessionAuthGuard)
  read(@Req() request: RequestLike): { username: string } {
    return { username: request.auth?.username ?? '' };
  }

  @Get('operator')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('operator')
  operator(@Req() request: RequestLike): { username: string } {
    return { username: request.auth?.username ?? '' };
  }

  @Get('finance')
  @UseGuards(SessionAuthGuard, RolesGuard)
  @Roles('approver_finance')
  finance(@Req() request: RequestLike): { username: string } {
    return { username: request.auth?.username ?? '' };
  }

  @Post('mutate')
  @UseGuards(SessionAuthGuard, SessionCsrfGuard, RolesGuard)
  @Roles('operator')
  mutate(@Req() request: RequestLike): { mutated: true; username: string } {
    return { mutated: true, username: request.auth?.username ?? '' };
  }
}

@Module({
  imports: [AuthModule],
  controllers: [AuthTestController],
})
class AuthTestModule {}

const app = await NestFactory.create(AuthTestModule, { logger: false });
app.useGlobalFilters(new ProblemFilter());
await app.listen(0, '127.0.0.1');
const address = app.getHttpServer().address() as AddressInfo | string | null;
if (!address || typeof address === 'string') {
  throw new Error('Auth test app did not expose a TCP address');
}
console.log(`NEXUS_AUTH_TEST_READY port=${address.port}`);

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) {
    return;
  }
  stopping = true;
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => {
  void stop();
});
process.on('SIGINT', () => {
  void stop();
});
