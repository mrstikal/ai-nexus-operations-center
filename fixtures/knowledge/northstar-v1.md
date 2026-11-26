# Northstar Autonomous Operations Policy

Policy id: northstar
Policy revision: northstar-v1
Status: active

## Purpose

This policy governs which proposed actions an operator may submit, what the
application must calculate, and which human approval roles are required before
any approved plan can be executed. The policy is a reviewed configuration
artifact paired with compiled code. It cannot grant roles, widen a hard
threshold, add an action handler, or authorise generic scripting.

## Supply commitments

Every purchase-order proposal requires an operations approval. A finance
approval is additionally required when the cumulative additional procurement
commitment for the case exceeds EUR 500.00. Cumulative means the sum of prior
successfully executed additional commitments for the same case plus every new
purchase-order commitment in the whole plan. A plan with two purchase orders
that are individually below EUR 500.00 therefore requires finance when their
combined value crosses the threshold.

The calculated commitment includes all goods lines at their submitted unit
prices plus every explicit expedite charge. Separate approval slots must be
filled by separate authorised users. No user can satisfy two role slots for the
same revision.

Only one open unexecuted procurement plan is permitted per case. Editing one
item invalidates the entire previous revision, its plan hash and any pending
decisions.

## Communications and business writes

Customer and supplier communications require an operations approval. Money,
stock, invoice, customer, order, delivery and address writes always require
human approval. No communication, monetary, inventory or business-status write
is eligible for automatic execution.

## Low-risk automation

The only low-risk automatically executable action is an internal case note. It
may not be sent to a customer or supplier, may not change enterprise state, and
is limited to plain text of at most 2,000 characters. The bundle may disable
this automation but may not add another action kind.

## Evidence and provenance

Every enterprise action item requires at least one available evidence
reference. Missing evidence must be reported as missing rather than filled by
model output. Evidence must belong to the same sandbox and may not belong to a
different case. The plan binds the observed enterprise entity versions that its
evidence and targets rely on.

## Approval lifetime and invalidation

A pending revision expires after at most 24 hours. It is also expired when an
enterprise entity referenced by the plan, or by its evidence, changes for a
reason other than the revision's own approved execution. Approvals bind the
proposal, action revision, whole-plan hash and role slots; a changed plan
requires new approvals. A pending or approved proposal is never itself an
execution authorisation until the typed execution stage proves the revision
still current.

## Prohibited shortcuts

Models and operators may draft only allowlisted action fields and prose. They
may not set statuses, required roles, approval decisions, dependencies,
expected versions, policy thresholds or plan hashes. No generic policy
scripting language is supported. Declared action schemas do not enable action
kinds that have no implemented handler and policy rule.
