import type { ZodType } from 'zod';

// Context passed to a handler when an approved submission is pushed downstream.
export interface PushContext {
  // Absolute path to the reviewer-visible screenshot, if one was uploaded.
  screenshotPath: string | null;
  // Display name of the submitter, or null if they submitted anonymously.
  submitter?: string | null;
}

// A SubmissionHandler is the ONLY place a given submission type's knowledge
// lives. The storage, auth, review UI, and approve/reject plumbing are written
// once and are type-agnostic — so adding e.g. weekly-set submissions later is
// just a new handler (+ a new form on the website), nothing else.
export interface SubmissionHandler<P = unknown> {
  // Stable key stored on each row and sent by the website (e.g. "combo").
  type: string;
  // Human label for the review UI.
  label: string;
  // Whether the public form may attach a screenshot for this type.
  acceptsScreenshot?: boolean;
  // Validates the raw payload from the website. Rejected at submit time.
  schema: ZodType<P>;
  // Optional async check run after schema validation but before the row is stored.
  // Throw an Error with a user-facing message to reject the submission (→ HTTP 409).
  preSubmit?(payload: P): Promise<void>;
  // One-line summary shown in the review list.
  summarize(payload: P): string;
  // Pushes an approved submission to its destination (e.g. a Teable table).
  // Returns an optional downstream reference id (stored for the audit trail).
  pushDown(payload: P, ctx: PushContext): Promise<string | void>;
}
