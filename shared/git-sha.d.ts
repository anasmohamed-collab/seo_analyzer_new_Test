export const GIT_SHA_ENV_VARS: readonly string[];

export interface ResolvedGitSha {
  gitSha: string | null;
  gitShaShort: string | null;
  gitShaSource: string | null;
}

export function normalizeGitSha(raw: unknown): string | null;
export function isValidGitSha(raw: unknown): boolean;
export function shortGitSha(raw: unknown): string | null;
export function resolveGitSha(env?: Record<string, string | undefined>): ResolvedGitSha;
