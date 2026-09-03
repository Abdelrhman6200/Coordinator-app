import type { Denial } from '@coordinator/permissions';

/**
 * A refusal the UI renders verbatim. Structured, so the client never has to
 * parse an English sentence to decide what to show.
 *
 * Fields are declared and assigned explicitly rather than as TypeScript
 * parameter properties: Node's strip-only type stripping (which is how the API
 * and web servers run, with no build step) rejects parameter properties, so the
 * shorthand would make the servers fail to boot.
 */
export class DomainError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export class DeniedError extends DomainError {
  readonly denial: Denial;

  constructor(denial: Denial) {
    super(denial.code, denial.reason, { required: denial.required });
    this.name = 'DeniedError';
    this.denial = denial;
  }
}

export class ValidationError extends DomainError {
  readonly violations: ReadonlyArray<{ field: string; rule: string; message: string }>;

  constructor(
    message: string,
    violations: ReadonlyArray<{ field: string; rule: string; message: string }>,
  ) {
    super('VALIDATION_FAILED', message, { violations });
    this.name = 'ValidationError';
    this.violations = violations;
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
