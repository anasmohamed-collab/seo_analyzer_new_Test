import { describe, expect, it, vi } from 'vitest';
import {
  OutboundUrlSafetyError,
  assertSafeOutboundUrl,
  fetchWithSafeRedirects,
  isPublicIpAddress,
} from '../../../../../shared/outbound-url-safety.js';
import type { OutboundHostResolver } from '../../../../../shared/outbound-url-safety.js';

const PUBLIC_RESOLVER: OutboundHostResolver = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
];

function response(status: number, location?: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(location ? { location } : {}),
    text: async () => 'ok',
  } as unknown as Response;
}

describe('outbound URL safety policy', () => {
  it('allows public IPv4 and IPv6 addresses', () => {
    expect(isPublicIpAddress('8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('2001:4860:4860::8888')).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '64:ff9b::a00:1',
  ])('blocks non-public address %s', address => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it('allows only HTTP and HTTPS', async () => {
    await expect(assertSafeOutboundUrl('file:///etc/passwd', { resolver: PUBLIC_RESOLVER }))
      .rejects.toMatchObject({ reason: 'invalid_protocol' });
  });

  it.each([
    'http://localhost/',
    'http://metadata.google.internal/',
    'http://service.internal/',
    'http://instance-data/',
  ])('blocks reserved or metadata hostname %s', async url => {
    await expect(assertSafeOutboundUrl(url, { resolver: PUBLIC_RESOLVER }))
      .rejects.toBeInstanceOf(OutboundUrlSafetyError);
  });

  it('checks every A and AAAA result and rejects DNS-to-private resolution', async () => {
    const resolver: OutboundHostResolver = async () => [
      { address: '93.184.216.34', family: 4 },
      { address: 'fd00::1', family: 6 },
    ];

    await expect(assertSafeOutboundUrl('https://mixed.example/', { resolver }))
      .rejects.toMatchObject({ reason: 'dns_to_non_public_ip' });
  });

  it('fails closed when neither A nor AAAA records resolve', async () => {
    await expect(assertSafeOutboundUrl('https://missing.example/', { resolver: async () => [] }))
      .rejects.toMatchObject({ reason: 'dns_failure' });
  });

  it('validates each redirect destination before requesting it', async () => {
    const fetchSpy = vi.fn(async (_input?: string | URL | Request, _init?: RequestInit) =>
      response(302, 'http://169.254.169.254/latest/meta-data'));
    const fetchFn = fetchSpy as unknown as typeof fetch;

    await expect(fetchWithSafeRedirects(
      'https://public.example/',
      {},
      { fetchFn, resolver: PUBLIC_RESOLVER },
    )).rejects.toMatchObject({ reason: 'non_public_ip' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
  });

  it('follows safe redirects manually and returns the complete chain', async () => {
    const fetchSpy = vi.fn(async (_input?: string | URL | Request, _init?: RequestInit) => response(200))
      .mockResolvedValueOnce(response(301, '/next'))
      .mockResolvedValueOnce(response(200));
    const fetchFn = fetchSpy as unknown as typeof fetch;

    const result = await fetchWithSafeRedirects(
      'https://public.example/start',
      {},
      { fetchFn, resolver: PUBLIC_RESOLVER },
    );

    expect(result.finalUrl).toBe('https://public.example/next');
    expect(result.redirectChain).toEqual(['https://public.example/start']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls.every(call => (call[1] as RequestInit | undefined)?.redirect === 'manual')).toBe(true);
  });
});
