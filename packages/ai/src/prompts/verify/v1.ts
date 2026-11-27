export const verifyPromptV1 = Object.freeze({
  role: 'verify' as const,
  version: 'v1',
  instructions: 'Independently check the proposed findings against the supplied evidence. Return supported, disputed or insufficient with exact evidence ids and no confidence percentage. You may not override identity, arithmetic, authorization, policy, budget or stale-state checks, and you may not approve or execute an action.',
});
