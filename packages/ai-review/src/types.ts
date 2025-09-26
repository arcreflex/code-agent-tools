export interface ReviewOptions {
  readonly projectContext: string[];
  readonly objective?: string;
  readonly preview?: boolean;
  readonly dryRun?: boolean;
  readonly dangerouslyAllowSecrets?: boolean;
}

export interface ReviewRequest extends ReviewOptions {
  readonly kind: "range" | "staged";
  readonly oldRevision?: string;
  readonly newRevision?: string;
  readonly diff: string;
  readonly summary: DiffSummary;
  readonly contextFiles: ContextFile[];
  readonly omittedContext: string[];
  readonly redacted: boolean;
  readonly createdAt: string;
  readonly jobKey: string;
  readonly commitMessages: string[];
}

export interface DiffSummary {
  readonly additions: number;
  readonly deletions: number;
  readonly files: number;
  readonly bytes: number;
}

export interface ContextFile {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface ReviewJob {
  readonly key: string;
  status: "pending" | "running" | "completed" | "failed";
  request: ReviewRequest;
  readonly log: string[];
  result?: FinalReview;
  error?: string;
  reviewPath?: string;
}

export interface FinalReview {
  readonly status: "pass" | "block";
  readonly blockers: ReviewBlocker[];
  readonly notes: string[];
}

export interface ReviewBlocker {
  readonly rule: string;
  readonly title: string;
  readonly file: string;
  readonly line_start: number;
  readonly line_end: number;
  readonly why: string;
  readonly suggested_fix?: string;
}

export interface SecretMatch {
  readonly pattern: string;
  readonly excerpt: string;
  readonly line: number;
}
