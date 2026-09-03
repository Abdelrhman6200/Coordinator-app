/**
 * Separation of duties for DEPI Round 5.
 *
 * These are subtractive: evaluated AFTER the union of role grants, and they
 * always win. A violation is blocked and logged, never silently ignored and
 * never merely hidden in the UI -- hiding a control is a courtesy, this is the
 * enforcement.
 *
 * The confirmed pipeline is student -> coach -> coordinator L1 -> Quality L2 ->
 * Quality Lead L3, so the separations that matter are between those stages, and
 * around Quality's independence.
 */
import type { Decision, Denial, Module, Verb } from './model.ts';
import { ALLOW } from './model.ts';

function block(module: Module, verb: Verb, reason: string): Extract<Decision, { allowed: false }> {
  const denial: Denial = {
    code: 'SEPARATION_OF_DUTIES',
    required: { module, verb },
    actorScopes: [],
    reason,
  };
  return { allowed: false, denial };
}

export type EvidenceStage = 'coach' | 'l1' | 'l2' | 'l3';

const STAGE_LABEL: Record<EvidenceStage, string> = {
  coach: 'coach review',
  l1: 'coordinator screening',
  l2: 'Quality review',
  l3: 'Quality Lead review',
};

/**
 * SoD-1: no one reviews their own submission, and no one reviews the same
 * submission at two stages.
 *
 * The student is the submitter (§10), so the usual case is a staff member who
 * has already reviewed this item earlier in the pipeline attempting to review it
 * again -- which would collapse a four-stage check into one opinion.
 */
export function checkEvidenceReview(input: {
  actorUserId: string;
  submittedByUserId: string;
  stage: EvidenceStage;
  /** Who has already decided this submission, by stage. */
  priorReviewers: Readonly<Partial<Record<EvidenceStage, string>>>;
}): Decision {
  if (input.actorUserId === input.submittedByUserId) {
    return block(
      'evidence',
      'edit',
      'You submitted this evidence, so you cannot review it.',
    );
  }
  for (const [stage, reviewer] of Object.entries(input.priorReviewers)) {
    if (stage === input.stage) continue;
    if (reviewer === input.actorUserId) {
      return block(
        'evidence',
        'edit',
        `You already decided this submission at ${STAGE_LABEL[stage as EvidenceStage]}, so ` +
          `you cannot also decide it at ${STAGE_LABEL[input.stage]}. Each stage must be an ` +
          'independent pair of eyes.',
      );
    }
  }
  return ALLOW;
}

/**
 * SoD-2: L3 is the Quality Lead's alone. A Quality Member cannot resolve an
 * escalation of their own rejection, which would make the dispute route
 * meaningless.
 */
export function checkL3Resolution(input: {
  actorUserId: string;
  actorIsQualityLead: boolean;
  l2ReviewerUserId: string | null;
}): Decision {
  if (!input.actorIsQualityLead) {
    return block(
      'quality',
      'approve',
      'Level 3 review is reserved to the Quality Lead.',
    );
  }
  if (input.l2ReviewerUserId !== null && input.actorUserId === input.l2ReviewerUserId) {
    return block(
      'quality',
      'approve',
      'You made the Level 2 decision being disputed, so you cannot also decide the ' +
        'dispute. This case must go to another Quality Lead or to the Project Manager.',
    );
  }
  return ALLOW;
}

/**
 * SoD-3: a Quality decision is immutable to everyone outside Quality --
 * administrators included (§5, §59).
 */
export function checkQualityDecisionEdit(input: {
  actorIsQuality: boolean;
  actorIsQualityLead: boolean;
  decisionIsLocked: boolean;
}): Decision {
  if (!input.actorIsQuality) {
    return block(
      'quality',
      'edit',
      'Quality decisions can only be changed within Quality. No operational or ' +
        'administrative role may edit or delete a Quality review decision.',
    );
  }
  if (input.decisionIsLocked && !input.actorIsQualityLead) {
    return block(
      'quality',
      'override_lock',
      'This Quality decision is locked. Only the Quality Lead may reopen it, with a ' +
        'recorded reason and a new version.',
    );
  }
  return ALLOW;
}

/** SoD-4: nobody double-reviews an item for calibration that they first reviewed. */
export function checkCalibrationAssignment(input: {
  auditorUserId: string;
  originalReviewerUserId: string;
}): Decision {
  if (input.auditorUserId !== input.originalReviewerUserId) return ALLOW;
  return block(
    'quality',
    'audit',
    'Calibration measures agreement between two reviewers, so the second review ' +
      'cannot be by the reviewer who made the first.',
  );
}

/** SoD-5: nobody audits their own work or a direct report's (staff auditing). */
export function checkAuditAssignment(input: {
  auditorUserId: string;
  auditeeUserId: string;
  auditorDirectReportIds: readonly string[];
}): Decision {
  if (input.auditorUserId === input.auditeeUserId) {
    return block('quality', 'audit', 'An auditor cannot audit their own work.');
  }
  if (input.auditorDirectReportIds.includes(input.auditeeUserId)) {
    return block(
      'quality',
      'audit',
      'An auditor cannot audit a direct report. This record will be reassigned to ' +
        'another auditor.',
    );
  }
  return ALLOW;
}

export type ComplaintCategory =
  | 'coach'
  | 'operations'
  | 'evidence_dispute'
  | 'misconduct'
  | 'privacy'
  | 'other';

/**
 * SoD-6: a complaint is never routed ONLY to the function it is about (§44,
 * §67). The Quality Lead owns every complaint independently; the subject
 * function may be given the action, but never sole ownership.
 */
export function checkComplaintRouting(input: {
  category: ComplaintCategory;
  ownerIsQualityLead: boolean;
  actionFunction: string | null;
}): Decision {
  if (!input.ownerIsQualityLead) {
    return block(
      'escalations',
      'assign',
      'Every complaint is owned by the Quality Lead. The function the complaint is ' +
        'about may be assigned the corrective action, but it cannot own the case.',
    );
  }
  const subjectFunction: Partial<Record<ComplaintCategory, string>> = {
    coach: 'coach_operations',
    operations: 'project_operations',
  };
  const subject = subjectFunction[input.category];
  if (subject && input.actionFunction === subject) {
    // Permitted: routing the ACTION to the subject function is the documented
    // flow. Ownership stays with Quality, which the check above guarantees.
    return ALLOW;
  }
  return ALLOW;
}

/**
 * SoD-7: graduation is computed, never entered (§40, requirement "no manual
 * Graduate = Yes field").
 *
 * There is no role that may set it, so this takes no actor: the answer is always
 * no. It exists as an explicit guard so an attempt is blocked AND logged rather
 * than silently ignored by a missing route.
 */
export function checkManualGraduation(): Decision {
  return block(
    'graduation',
    'edit',
    'Graduation is calculated from Quality-accepted evidence and cannot be set by ' +
      'hand. To change a graduation outcome, correct the evidence it is computed from.',
  );
}

/**
 * SoD-8: an unresponsive status needs the attempt history behind it, or an
 * explicit authorised override with a reason (§15).
 */
export function checkUnresponsiveStatus(input: {
  attemptCount: number;
  requiredAttempts: number;
  daysSinceFirstAttempt: number;
  requiredDays: number;
  actorMaySetUnresponsive: boolean;
  overrideReason: string | null;
}): Decision {
  if (!input.actorMaySetUnresponsive) {
    return block(
      'students',
      'edit',
      'Only Project Operations may set a student to Unresponsive.',
    );
  }
  const historyComplete =
    input.attemptCount >= input.requiredAttempts &&
    input.daysSinceFirstAttempt >= input.requiredDays;
  if (historyComplete) return ALLOW;
  if (input.overrideReason && input.overrideReason.trim().length > 0) return ALLOW;
  return block(
    'students',
    'edit',
    `Unresponsive requires ${input.requiredAttempts} logged attempts across channels over ` +
      `${input.requiredDays} days. This student has ${input.attemptCount} attempt(s) over ` +
      `${input.daysSinceFirstAttempt} day(s). Record the remaining attempts, or supply an ` +
      'override reason.',
  );
}
