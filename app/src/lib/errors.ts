export type RpcErrorKind = 'network' | 'auth' | 'rejected';

export interface RpcErrorLike {
  status?: number;
  code?: string;
  message?: string;
}

const NETWORK_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const NETWORK_MESSAGE = /network request failed|failed to fetch|fetch failed|network error|timed? ?out|aborterror|aborted|offline|internet connection/i;
const AUTH_CODES = new Set(['PGRST301', 'PGRST302', 'PGRST303']);

export function classifyRpcError(error: unknown): RpcErrorKind {
  const e = (typeof error === 'object' && error !== null ? error : {}) as RpcErrorLike;
  const message = typeof e.message === 'string' ? e.message : String(error);
  const status = typeof e.status === 'number' ? e.status : undefined;
  if (status !== undefined && NETWORK_STATUSES.has(status)) return 'network';
  if (status === 401 || (e.code && AUTH_CODES.has(e.code))) return 'auth';
  if (status === undefined && NETWORK_MESSAGE.test(message)) return 'network';
  return 'rejected';
}

export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const m = (error as { message: unknown }).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return String(error);
}
