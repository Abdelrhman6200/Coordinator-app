import type { Denial } from '@coordinator/permissions';

/**
 * A refusal the UI renders verbatim. Structured, so the client never has to
 * parse an English sentence to decide what to show.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class DeniedError extends DomainError {
  constructor(readonly denial: Denial) {
    super(denial.code, denial.reason, { required: denial.required });
    this.name = 'DeniedError';
  }
}

export class ValidationError extends DomainError {
  constructor(
    message: string,
    readonly violations: ReadonlyArray<{ field: string; rule: string; message: string }>,
  ) {
    super('VALIDATION_FAILED', message, { violations });
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends DomainError {
  constructor(what: string) {
    // Deliberately vague: a "not found" that distinguishes "does not exist" from
    // "exists but you may not see it" leaks existence.
    super('NOT_FOUND', `${what} was not found, or you do not have access to it.`);
    this.name = 'NotFoundError';
  }
}
