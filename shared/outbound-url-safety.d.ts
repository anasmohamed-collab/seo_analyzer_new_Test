export interface OutboundAddress {
  address: string;
  family?: number;
}

export type OutboundHostResolver = (
  hostname: string,
) => Promise<ReadonlyArray<string | OutboundAddress>>;

export interface OutboundSafetyOptions {
  resolver?: OutboundHostResolver;
}

export interface SafeFetchOptions extends OutboundSafetyOptions {
  fetchFn?: typeof fetch;
  maxRedirects?: number;
}

export class OutboundUrlSafetyError extends Error {
  code: 'OUTBOUND_URL_BLOCKED';
  reason: string;
  constructor(message: string, reason?: string);
}

export function isPublicIpAddress(address: string): boolean;
export function defaultOutboundHostResolver(hostname: string): Promise<OutboundAddress[]>;
export function assertSafeOutboundUrl(rawUrl: string | URL, options?: OutboundSafetyOptions): Promise<URL>;
export function fetchWithSafeRedirects(
  rawUrl: string | URL,
  init?: RequestInit,
  options?: SafeFetchOptions,
): Promise<{ response: Response; finalUrl: string; redirectChain: string[] }>;
export function safeFetch(
  rawUrl: string | URL,
  init?: RequestInit,
  options?: SafeFetchOptions,
): Promise<Response>;
