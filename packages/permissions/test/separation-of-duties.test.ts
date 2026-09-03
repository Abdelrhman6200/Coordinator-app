import { describe, expect, it } from 'vitest';
import {
  checkAuditAssignment,
  checkCalibrationAssignment,
  checkComplaintRouting,
  checkEvidenceReview,
  checkL3Resolution,
  checkManualGraduation,
  checkQualityDecisionEdit,
  checkUnresponsiveStatus,
} from '../src/index.ts';

describe('SoD-1 evidence stages are independent', () => {
  it('blocks a submitter reviewing their own evidence', () => {
    const d = checkEvidenceReview({
      actorUserId: 's1',
      submittedByUserId: 's1',
      stage: 'coach',
      priorReviewers: {},
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.denial.code).toBe('SEPARATION_OF_DUTIES');
  });

  it('blocks the coach reviewer from also performing L1', () => {
    const d = checkEvidenceReview({
      actorUserId: 'c1',
      submittedByUserId: 's1',
      stage: 'l1',
      priorReviewers: { coach: 'c1' },
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.denial.reason).toContain('independent pair of eyes');
  });

  it('blocks the L1 screener from also performing L2', () => {
    expect(
      checkEvidenceReview({
        actorUserId: 'k1',
        submittedByUserId: 's1',
        stage: 'l2',
        priorReviewers: { coach: 'c1', l1: 'k1' },
      }).allowed,
    ).toBe(false);
  });

  it('allows a genuinely independent reviewer at each stage', () => {
    expect(
      checkEvidenceReview({
        actorUserId: 'q1',
        submittedByUserId: 's1',
        stage: 'l2',
        priorReviewers: { coach: 'c1', l1: 'k1' },
      }).allowed,
    ).toBe(true);
  });

  it('allows the same reviewer to re-decide their own stage after a correction', () => {
    // A resubmission returning to the same coach is the intended loop, not a
    // separation failure.
    expect(
      checkEvidenceReview({
        actorUserId: 'c1',
        submittedByUserId: 's1',
        stage: 'coach',
        priorReviewers: { coach: 'c1' },
      }).allowed,
    ).toBe(true);
  });
});

describe('SoD-2 L3 belongs to the Quality Lead', () => {
  it('blocks a Quality Member from resolving L3', () => {
    expect(
      checkL3Resolution({
        actorUserId: 'q1',
        actorIsQualityLead: false,
        l2ReviewerUserId: 'q2',
      }).allowed,
    ).toBe(false);
  });

  it('blocks a Lead from deciding a dispute of their own L2 decision', () => {
    expect(
      checkL3Resolution({
        actorUserId: 'ql',
        actorIsQualityLead: true,
        l2ReviewerUserId: 'ql',
      }).allowed,
    ).toBe(false);
  });

  it('allows the Lead to decide a dispute of someone else’s decision', () => {
    expect(
      checkL3Resolution({
        actorUserId: 'ql',
        actorIsQualityLead: true,
        l2ReviewerUserId: 'q1',
      }).allowed,
    ).toBe(true);
  });
});

describe('SoD-3 Quality decisions are immutable outside Quality', () => {
  it('blocks an operational or administrative actor', () => {
    const d = checkQualityDecisionEdit({
      actorIsQuality: false,
      actorIsQualityLead: false,
      decisionIsLocked: false,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.denial.reason).toContain('only be changed within Quality');
  });

  it('blocks a Quality Member from reopening a locked decision', () => {
    expect(
      checkQualityDecisionEdit({
        actorIsQuality: true,
        actorIsQualityLead: false,
        decisionIsLocked: true,
      }).allowed,
    ).toBe(false);
  });

  it('allows the Quality Lead to reopen a locked decision', () => {
    expect(
      checkQualityDecisionEdit({
        actorIsQuality: true,
        actorIsQualityLead: true,
        decisionIsLocked: true,
      }).allowed,
    ).toBe(true);
  });
});

describe('SoD-4 calibration needs two different reviewers', () => {
  it('blocks self-calibration', () => {
    expect(
      checkCalibrationAssignment({ auditorUserId: 'q1', originalReviewerUserId: 'q1' }).allowed,
    ).toBe(false);
  });
  it('allows a second reviewer', () => {
    expect(
      checkCalibrationAssignment({ auditorUserId: 'q2', originalReviewerUserId: 'q1' }).allowed,
    ).toBe(true);
  });
});

describe('SoD-5 nobody audits themselves or a direct report', () => {
  it('blocks self-audit and direct reports, allows others', () => {
    expect(
      checkAuditAssignment({ auditorUserId: 'a', auditeeUserId: 'a', auditorDirectReportIds: [] })
        .allowed,
    ).toBe(false);
    expect(
      checkAuditAssignment({ auditorUserId: 'a', auditeeUserId: 'b', auditorDirectReportIds: ['b'] })
        .allowed,
    ).toBe(false);
    expect(
      checkAuditAssignment({ auditorUserId: 'a', auditeeUserId: 'c', auditorDirectReportIds: ['b'] })
        .allowed,
    ).toBe(true);
  });
});

describe('SoD-6 a complaint is never owned by the function it is about', () => {
  it('blocks ownership by anyone but the Quality Lead', () => {
    const d = checkComplaintRouting({
      category: 'coach',
      ownerIsQualityLead: false,
      actionFunction: 'coach_operations',
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.denial.reason).toContain('owned by the Quality Lead');
  });

  it('allows the action to go to the subject function while Quality retains the case', () => {
    expect(
      checkComplaintRouting({
        category: 'coach',
        ownerIsQualityLead: true,
        actionFunction: 'coach_operations',
      }).allowed,
    ).toBe(true);
  });
});

describe('SoD-7 graduation cannot be set by hand (§40)', () => {
  it('refuses unconditionally, for every actor', () => {
    const d = checkManualGraduation();
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.denial.reason).toContain('calculated from Quality-accepted evidence');
      expect(d.denial.reason).toContain('correct the evidence');
    }
  });
});

describe('SoD-8 Unresponsive needs its history (§15)', () => {
  const base = {
    requiredAttempts: 5,
    requiredDays: 14,
    actorMaySetUnresponsive: true,
    overrideReason: null,
  };

  it('blocks a role that may not set the status at all', () => {
    expect(
      checkUnresponsiveStatus({
        ...base,
        attemptCount: 5,
        daysSinceFirstAttempt: 14,
        actorMaySetUnresponsive: false,
      }).allowed,
    ).toBe(false);
  });

  it('blocks when too few attempts are logged', () => {
    const d = checkUnresponsiveStatus({ ...base, attemptCount: 3, daysSinceFirstAttempt: 20 });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.denial.reason).toContain('3 attempt(s)');
  });

  it('blocks when the attempts are compressed into too short a period', () => {
    // Five attempts in two days is not five attempts over two weeks.
    expect(
      checkUnresponsiveStatus({ ...base, attemptCount: 5, daysSinceFirstAttempt: 2 }).allowed,
    ).toBe(false);
  });

  it('allows once both the attempt count and the period are satisfied', () => {
    expect(
      checkUnresponsiveStatus({ ...base, attemptCount: 5, daysSinceFirstAttempt: 14 }).allowed,
    ).toBe(true);
  });

  it('allows an authorised override that records a reason', () => {
    expect(
      checkUnresponsiveStatus({
        ...base,
        attemptCount: 2,
        daysSinceFirstAttempt: 3,
        overrideReason: 'Ministry confirmed the student has emigrated',
      }).allowed,
    ).toBe(true);
  });

  it('does not accept a blank override reason as an override', () => {
    expect(
      checkUnresponsiveStatus({
        ...base,
        attemptCount: 2,
        daysSinceFirstAttempt: 3,
        overrideReason: '   ',
      }).allowed,
    ).toBe(false);
  });
});
