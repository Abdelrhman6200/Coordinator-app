import { describe, expect, it } from 'vitest';
import {
  checkAuditAssignment,
  checkCorrectiveActionClosure,
  checkEscalationClosure,
  checkGigVerification,
  checkGraduationApproval,
} from '../src/index.ts';

describe('SoD-1 gig submitter cannot verify (AC-06)', () => {
  it('blocks the submitter', () => {
    const d = checkGigVerification({ actorUserId: 'u1', gigSubmittedBy: 'u1' });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.denial.code).toBe('SEPARATION_OF_DUTIES');
  });
  it('allows anyone else', () => {
    expect(checkGigVerification({ actorUserId: 'u2', gigSubmittedBy: 'u1' }).allowed).toBe(true);
  });
});

describe('SoD-2 gig verifier cannot approve the dependent graduation (AC-07)', () => {
  const base = { routeGigVerifierIds: ['v1', 'v2'], singleApproverMode: false };
  it('blocks a verifier of a backing gig', () => {
    expect(checkGraduationApproval({ ...base, actorUserId: 'v1' }).allowed).toBe(false);
  });
  it('allows an approver who verified none of them', () => {
    expect(checkGraduationApproval({ ...base, actorUserId: 'a1' }).allowed).toBe(true);
  });
  it('allows the verifier when single-approver mode is explicitly enabled', () => {
    expect(
      checkGraduationApproval({ ...base, actorUserId: 'v1', singleApproverMode: true }).allowed,
    ).toBe(true);
  });
});

describe('SoD-3 nobody audits themselves or a direct report (AC-15)', () => {
  it('blocks self-audit', () => {
    expect(
      checkAuditAssignment({
        auditorUserId: 'a',
        auditeeUserId: 'a',
        auditorDirectReportIds: [],
      }).allowed,
    ).toBe(false);
  });
  it('blocks auditing a direct report', () => {
    expect(
      checkAuditAssignment({
        auditorUserId: 'a',
        auditeeUserId: 'b',
        auditorDirectReportIds: ['b'],
      }).allowed,
    ).toBe(false);
  });
  it('allows an unrelated auditee', () => {
    expect(
      checkAuditAssignment({
        auditorUserId: 'a',
        auditeeUserId: 'c',
        auditorDirectReportIds: ['b'],
      }).allowed,
    ).toBe(true);
  });
});

describe('SoD-4 escalation resolver cannot approve their own closure', () => {
  const threshold = 2; // CONFIG-PENDING register item 9; passed in, never assumed
  it('blocks at the threshold', () => {
    expect(
      checkEscalationClosure({
        actorUserId: 'u1',
        resolvedByUserId: 'u1',
        severity: 2,
        sodSeverityThreshold: threshold,
      }).allowed,
    ).toBe(false);
  });
  it('blocks above the threshold', () => {
    expect(
      checkEscalationClosure({
        actorUserId: 'u1',
        resolvedByUserId: 'u1',
        severity: 5,
        sodSeverityThreshold: threshold,
      }).allowed,
    ).toBe(false);
  });
  it('allows below the threshold', () => {
    expect(
      checkEscalationClosure({
        actorUserId: 'u1',
        resolvedByUserId: 'u1',
        severity: 1,
        sodSeverityThreshold: threshold,
      }).allowed,
    ).toBe(true);
  });
  it('allows a different approver at any severity', () => {
    expect(
      checkEscalationClosure({
        actorUserId: 'u2',
        resolvedByUserId: 'u1',
        severity: 5,
        sodSeverityThreshold: threshold,
      }).allowed,
    ).toBe(true);
  });
});

describe('SoD-5 nobody closes a corrective action raised against themselves', () => {
  it('blocks the subject', () => {
    expect(
      checkCorrectiveActionClosure({ actorUserId: 'u1', findingSubjectUserId: 'u1' }).allowed,
    ).toBe(false);
  });
  it('allows a manager', () => {
    expect(
      checkCorrectiveActionClosure({ actorUserId: 'm1', findingSubjectUserId: 'u1' }).allowed,
    ).toBe(true);
  });
  it('allows when the finding targets a team rather than a person', () => {
    expect(
      checkCorrectiveActionClosure({ actorUserId: 'u1', findingSubjectUserId: null }).allowed,
    ).toBe(true);
  });
});
