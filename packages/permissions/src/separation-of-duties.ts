/**
 * Separation of duties: five subtractive rules (docs/02 §4).
 *
 * These are evaluated AFTER the union of role permissions and always win. A
 * violation is blocked and logged -- never silently ignored, and never merely
 * hidden in the UI. The UI hides the control as a courtesy; this is the
 * enforcement.
 */
import type { Decision, Denial, Module, Verb } from './model.ts';
import { ALLOW } from './model.ts';

function block(
  module: Module,
  verb: Verb,
  reason: string,
): Extract<Decision, { allowed: false }> {
  const denial: Denial = {
    code: 'SEPARATION_OF_DUTIES',
    required: { module, verb },
    actorScopes: [],
    reason,
  };
  return { allowed: false, denial };
}

/** SoD-1: the person who submits a gig cannot be the person who verifies it. */
export function checkGigVerification(input: {
  actorUserId: string;
  gigSubmittedBy: string;
}): Decision {
  if (input.actorUserId !== input.gigSubmittedBy) return ALLOW;
  return block(
    'gigs',
    'approve',
    'You submitted this gig, so you cannot verify it. Verification must be ' +
      'performed by a different person.',
  );
}

/**
 * SoD-2: a verifier of any gig backing the route cannot approve the graduation,
 * unless an admin has explicitly enabled documented single-approver mode -- which
 * is itself a CONFIG_CHANGED event and is stamped on every record approved
 * under it.
 */
export function checkGraduationApproval(input: {
  actorUserId: string;
  /** Reviewer ids of every gig satisfying the matched route. */
  routeGigVerifierIds: readonly string[];
  singleApproverMode: boolean;
}): Decision {
  if (input.singleApproverMode) return ALLOW;
  if (!input.routeGigVerifierIds.includes(input.actorUserId)) return ALLOW;
  return block(
    'graduation',
    'approve',
    'You verified one of the gigs this graduation relies on, so you cannot ' +
      'approve the graduation. A different authorised approver must approve it.',
  );
}

/**
 * SoD-3: nobody audits their own work or their direct reports' work. Checked at
 * sampling time AND re-checked at audit start, because the org can change in
 * between.
 */
export function checkAuditAssignment(input: {
  auditorUserId: string;
  auditeeUserId: string;
  /** Direct reports of the auditor, resolved from the effective-dated org. */
  auditorDirectReportIds: readonly string[];
}): Decision {
  if (input.auditorUserId === input.auditeeUserId) {
    return block('quality', 'audit', 'An auditor cannot audit their own work.');
  }
  if (input.auditorDirectReportIds.includes(input.auditeeUserId)) {
    return block(
      'quality',
      'audit',
      'An auditor cannot audit a direct report. This record will be reassigned ' +
        'to another auditor.',
    );
  }
  return ALLOW;
}

/**
 * SoD-4: nobody approves their own escalation resolution at or above the
 * configured severity threshold. The threshold is CONFIG-PENDING (register
 * item 9) and is passed in, never assumed here.
 */
export function checkEscalationClosure(input: {
  actorUserId: string;
  resolvedByUserId: string;
  severity: number;
  /** Severities at or above this require a different approver. */
  sodSeverityThreshold: number;
}): Decision {
  if (input.severity < input.sodSeverityThreshold) return ALLOW;
  if (input.actorUserId !== input.resolvedByUserId) return ALLOW;
  return block(
    'escalations',
    'approve',
    `You resolved this escalation, and at severity ${input.severity} the ` +
      'closure must be approved by a different person.',
  );
}

/**
 * SoD-5: nobody approves a corrective action arising from a finding raised
 * against themselves.
 */
export function checkCorrectiveActionClosure(input: {
  actorUserId: string;
  findingSubjectUserId: string | null;
}): Decision {
  if (input.findingSubjectUserId === null) return ALLOW;
  if (input.actorUserId !== input.findingSubjectUserId) return ALLOW;
  return block(
    'quality',
    'audit',
    'This corrective action was raised against you, so you cannot close it. ' +
      'Your manager or the Quality Lead must close it.',
  );
}
