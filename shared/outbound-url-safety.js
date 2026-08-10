import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';

const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
  'instance-data.ec2.internal',
]);

const RESERVED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
];

const IPV4_BLOCKS = [
  ['0.0.0.0', 8],       // unspecified / current host
  ['10.0.0.0', 8],      // private
  ['100.64.0.0', 10],   // shared address space
  ['127.0.0.0', 8],     // loopback
  ['169.254.0.0', 16],  // link-local and common metadata endpoints
  ['172.16.0.0', 12],   // private
  ['192.0.0.0', 24],    // IETF protocol assignments
  ['192.0.2.0', 24],    // documentation
  ['192.88.99.0', 24],  // deprecated 6to4 relay
  ['192.168.0.0', 16],  // private
  ['198.18.0.0', 15],   // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24],  // documentation
  ['224.0.0.0', 4],     // multicast
  ['240.0.0.0', 4],     // reserved / limited broadcast
];

const IPV6_BLOCKS = [
  ['::', 96],           // unspecified and deprecated IPv4-compatible space
  ['100::', 64],        // discard-only
  ['2001::', 23],       // IETF special-purpose assignments
  ['2001:db8::', 32],   // documentation
  ['2002::', 16],       // 6to4 (can encapsulate non-public IPv4)
  ['3fff::', 20],       // documentation
  ['5f00::', 16],       // segment-routing SIDs
  ['fc00::', 7],        // unique-local
  ['fe80::', 10],       // link-local
  ['ff00::', 8],        // multicast
];

export class OutboundUrlSafetyError extends Error {
  constructor(message, reason = 'blocked') {
    super(message);
    this.name = 'OutboundUrlSafetyError';
    this.code = 'OUTBOUND_URL_BLOCKED';
    this.reason = reason;
  }
}

function ipv4ToInt(address) {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function ipv4InCidr(address, base, prefix) {
  const value = ipv4ToInt(address);
  const network = ipv4ToInt(base);
  if (value === null || network === null) return false;
  const shift = 32 - prefix;
  return (value >>> shift) === (network >>> shift);
}

function ipv6ToBigInt(rawAddress) {
  let address = rawAddress.toLowerCase().replace(/^\[|\]$/g, '').split('%', 1)[0];

  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const ipv4 = ipv4ToInt(address.slice(lastColon + 1));
    if (ipv4 === null) return null;
    address = `${address.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }

  const doubleColon = address.indexOf('::');
  if (doubleColon !== -1 && doubleColon !== address.lastIndexOf('::')) return null;

  const head = doubleColon === -1 ? address.split(':') : address.slice(0, doubleColon).split(':').filter(Boolean);
  const tail = doubleColon === -1 ? [] : address.slice(doubleColon + 2).split(':').filter(Boolean);
  const missing = doubleColon === -1 ? 0 : 8 - head.length - tail.length;
  const parts = doubleColon === -1 ? head : [...head, ...Array(missing).fill('0'), ...tail];
  if (parts.length !== 8 || (doubleColon !== -1 && missing < 1)) return null;

  let value = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    value = (value << 16n) | BigInt(parseInt(part, 16));
  }
  return value;
}

function ipv6InCidr(address, base, prefix) {
  const value = ipv6ToBigInt(address);
  const network = ipv6ToBigInt(base);
  if (value === null || network === null) return false;
  const shift = 128n - BigInt(prefix);
  return (value >> shift) === (network >> shift);
}

function embeddedIpv4(address) {
  const value = ipv6ToBigInt(address);
  if (value === null) return null;
  const mappedBase = ipv6ToBigInt('::ffff:0:0');
  const nat64Base = ipv6ToBigInt('64:ff9b::');
  if (
    (mappedBase !== null && (value >> 32n) === (mappedBase >> 32n)) ||
    (nat64Base !== null && (value >> 32n) === (nat64Base >> 32n))
  ) {
    const tail = Number(value & 0xffffffffn);
    return `${tail >>> 24}.${(tail >>> 16) & 255}.${(tail >>> 8) & 255}.${tail & 255}`;
  }
  return null;
}

export function isPublicIpAddress(rawAddress) {
  const address = String(rawAddress).replace(/^\[|\]$/g, '').split('%', 1)[0];
  const family = isIP(address);
  if (family === 4) {
    return !IPV4_BLOCKS.some(([base, prefix]) => ipv4InCidr(address, base, prefix));
  }
  if (family === 6) {
    const embedded = embeddedIpv4(address);
    if (embedded && !isPublicIpAddress(embedded)) return false;
    if (ipv6InCidr(address, '64:ff9b:1::', 48)) return false;
    return !IPV6_BLOCKS.some(([base, prefix]) => ipv6InCidr(address, base, prefix));
  }
  return false;
}

export async function defaultOutboundHostResolver(hostname) {
  const [a, aaaa] = await Promise.allSettled([
    resolve4(hostname),
    resolve6(hostname),
  ]);
  const addresses = [];
  if (a.status === 'fulfilled') addresses.push(...a.value.map(address => ({ address, family: 4 })));
  if (aaaa.status === 'fulfilled') addresses.push(...aaaa.value.map(address => ({ address, family: 6 })));
  return addresses;
}

export async function assertSafeOutboundUrl(rawUrl, options = {}) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new OutboundUrlSafetyError('Outbound URL is invalid', 'invalid_url');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundUrlSafetyError('Outbound URL must use HTTP or HTTPS', 'invalid_protocol');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    METADATA_HOSTS.has(hostname) ||
    RESERVED_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))
  ) {
    throw new OutboundUrlSafetyError(`Outbound hostname is reserved: ${hostname}`, 'reserved_hostname');
  }

  if (isIP(hostname)) {
    if (!isPublicIpAddress(hostname)) {
      throw new OutboundUrlSafetyError(`Outbound IP address is not public: ${hostname}`, 'non_public_ip');
    }
    return url;
  }

  const resolver = options.resolver ?? defaultOutboundHostResolver;
  let resolved;
  try {
    resolved = await resolver(hostname);
  } catch {
    throw new OutboundUrlSafetyError(`Outbound hostname could not be resolved: ${hostname}`, 'dns_failure');
  }
  const addresses = (resolved ?? []).map(value => typeof value === 'string' ? value : value.address);
  if (addresses.length === 0) {
    throw new OutboundUrlSafetyError(`Outbound hostname has no A or AAAA records: ${hostname}`, 'dns_failure');
  }
  for (const address of addresses) {
    if (!isPublicIpAddress(address)) {
      throw new OutboundUrlSafetyError(
        `Outbound hostname resolves to a non-public address: ${hostname}`,
        'dns_to_non_public_ip',
      );
    }
  }
  return url;
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

function redirectRequestInit(init, status) {
  const currentMethod = String(init.method ?? 'GET').toUpperCase();
  if (status === 303 || ((status === 301 || status === 302) && currentMethod === 'POST')) {
    const headers = new Headers(init.headers);
    headers.delete('content-length');
    headers.delete('content-type');
    return { ...init, method: 'GET', body: undefined, headers };
  }
  return init;
}

export async function fetchWithSafeRedirects(rawUrl, init = {}, options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const maxRedirects = options.maxRedirects ?? 6;
  const requestedRedirectMode = init.redirect ?? 'follow';
  let currentUrl = String(rawUrl);
  let requestInit = { ...init, redirect: 'manual' };
  const redirectChain = [];

  for (let hop = 0; ; hop += 1) {
    await assertSafeOutboundUrl(currentUrl, { resolver: options.resolver });
    const response = await fetchFn(currentUrl, requestInit);
    const location = isRedirect(response.status) ? response.headers.get('location') : null;

    if (!location || requestedRedirectMode === 'manual') {
      return { response, finalUrl: currentUrl, redirectChain };
    }
    if (requestedRedirectMode === 'error') {
      throw new OutboundUrlSafetyError('Outbound request encountered a redirect', 'redirect_disallowed');
    }
    if (redirectChain.length >= maxRedirects) {
      throw new OutboundUrlSafetyError('Outbound request exceeded the redirect limit', 'redirect_limit');
    }

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl).href;
    } catch {
      throw new OutboundUrlSafetyError('Outbound redirect destination is invalid', 'invalid_redirect');
    }
    // Validation occurs before the next request, so a redirect can never bypass policy.
    await assertSafeOutboundUrl(nextUrl, { resolver: options.resolver });
    redirectChain.push(currentUrl);
    requestInit = { ...redirectRequestInit(requestInit, response.status), redirect: 'manual' };
    currentUrl = nextUrl;
  }
}

export async function safeFetch(rawUrl, init = {}, options = {}) {
  const { response, finalUrl, redirectChain } = await fetchWithSafeRedirects(rawUrl, init, options);
  if (redirectChain.length === 0) return response;
  return new Proxy(response, {
    get(target, property) {
      if (property === 'url') return finalUrl;
      if (property === 'redirected') return true;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
