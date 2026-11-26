import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generateOpenApiDocument } from '../../tools/generate-openapi.mjs';

const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

describe('F03 OpenAPI fixture parity', () => {
  it('matches the checked-in generated contract document', () => {
    const generated = `${JSON.stringify(generateOpenApiDocument(), null, 2)}\n`;
    const checkedIn = readFileSync(path.join(root, 'docs/openapi.json'), 'utf8');
    expect(generated).toBe(checkedIn);
  });

  it('exposes the stable components and current auth implementation status', () => {
    const document = generateOpenApiDocument() as unknown as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
      'x-nexus-implementation-status': Record<string, unknown>;
    };
    expect(Object.keys(document.paths).sort()).toEqual([
      '/api/v1/auth/csrf',
      '/api/v1/auth/login',
      '/api/v1/auth/logout',
      '/api/v1/auth/me',
      '/api/v1/cases',
      '/api/v1/cases/{caseId}',
      '/api/v1/cases/{caseId}/history',
      '/api/v1/evidence/{evidenceId}',
      '/api/v1/runs/{runId}/cancel',
      '/api/v1/runs/{runId}/resume',
      '/api/v1/sandbox',
    ]);
    expect(document['x-nexus-implementation-status']).toMatchObject({
      stage: 'F11A',
      httpControllers: 'auth, case reads, durable case intake and run control',
    });
    expect(Object.keys(document.components.schemas)).toEqual(
      expect.arrayContaining([
        'Money',
        'Problem',
        'ActionDraftPlan',
        'ActionRevision',
        'GatewayResult',
        'UiDescriptor',
        'EventEnvelope',
      ]),
    );

    const refs = [...JSON.stringify(document).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)]
      .map((match) => match[1])
      .filter((name): name is string => typeof name === 'string');
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(document.components.schemas[ref], ref).toBeDefined();
    }

    const money = document.components.schemas['Money'] as {
      properties: { amountMinor: { pattern: string } };
    };
    const cost = document.components.schemas['Cost'] as {
      properties: { amountMicrousd: { pattern: string } };
    };
    const moneyPattern = new RegExp(money.properties.amountMinor.pattern);
    const costPattern = new RegExp(cost.properties.amountMicrousd.pattern);
    expect(moneyPattern.test('1000000000000')).toBe(true);
    expect(moneyPattern.test('1000000000001')).toBe(false);
    expect(moneyPattern.test('-0')).toBe(false);
    expect(costPattern.test('0')).toBe(true);
    expect(costPattern.test('-1')).toBe(false);
  });
});
