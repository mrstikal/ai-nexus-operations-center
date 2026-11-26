import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeEnterpriseCommandItem,
  type EnterpriseBaseExpectedVersion,
  type EnterpriseCommandPayload,
} from '@nexus/contracts';

const id = '11111111-1111-4111-8111-111111111111';
const payloadTemplate: EnterpriseCommandPayload = {
  kind: 'enterprise.send_message',
  recipient: {
    system: 'enterprise',
    type: 'supplier',
    id,
    version: 1,
  },
  subject: 'Hash stability',
  parts: [{ kind: 'text', text: 'Stable order' }],
};

const baseExpectedVersions: EnterpriseBaseExpectedVersion[] = [
  {
    system: 'enterprise',
    type: 'agreement',
    id,
    reference: 'a-ref',
    version: 1,
  },
  {
    system: 'enterprise',
    type: 'agreement',
    id,
    reference: 'A-REF',
    version: 1,
  },
];

describe('F08 enterprise command item hash', () => {
  it('orders mixed-case base references by code unit and keeps a fixed digest', () => {
    const canonical = canonicalizeEnterpriseCommandItem({
      payloadTemplate,
      baseExpectedVersions,
    });

    expect(canonical.indexOf('"reference":"A-REF"')).toBeGreaterThanOrEqual(0);
    expect(canonical.indexOf('"reference":"A-REF"')).toBeLessThan(
      canonical.indexOf('"reference":"a-ref"'),
    );
    expect(
      createHash('sha256').update(canonical).digest('hex'),
    ).toBe('598fd527213467c711d717e5ea0125ab7098337998ba0edcd9e483dfd12c9c33');
  });
});
