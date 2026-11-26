import { RevisionRequestService, type RevisionRequestStore } from './clarification.js';

export const REANALYSIS_ROUTE = '/api/v1/proposals/:proposalId/reanalyse';

export class ReanalysisService extends RevisionRequestService {
  constructor(store: RevisionRequestStore) {
    super(store, 'reanalysis', REANALYSIS_ROUTE);
  }
}
