/**
 * Is this literal address one we must never fetch from a server-side request?
 *
 * WHATWG `URL` keeps IPv6 hostnames bracketed and normalises the decimal, hex and
 * short IPv4 forms, so callers pass `url.hostname` straight in and only the bracket
 * stripping is left to do here.
 */

type Cidr = [address: string, prefixBits: number];

const BLOCKED_V4: Cidr[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback, all of it — not just 127.0.0.1
  ["169.254.0.0", 16], // link-local, incl. the cloud metadata address
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, incl. 255.255.255.255
];

export function unbracket(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function ipv4ToInt(host: string): number | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inCidr(ip: number, [base, bits]: Cidr): boolean {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null) return false;
  const shift = 32 - bits;
  return Math.floor(ip / 2 ** shift) === Math.floor(baseInt / 2 ** shift);
}

function isPrivateV4(host: string): boolean | null {
  const ip = ipv4ToInt(host);
  if (ip === null) return null; // not an IPv4 literal
  return BLOCKED_V4.some((cidr) => inCidr(ip, cidr));
}

/** Expands an IPv6 literal to its eight 16-bit groups, or null if it is not one. */
function ipv6Groups(host: string): number[] | null {
  if (!host.includes(":")) return null;

  let text = host;
  let trailingV4: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const embedded = ipv4ToInt(tail);
    if (embedded === null) return null;
    trailingV4 = [Math.floor(embedded / 65536), embedded % 65536];
    text = text.slice(0, lastColon + 1) + "0:0";
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };

  const head = parse(halves[0]);
  const tailGroups = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || tailGroups === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const gap = 8 - head.length - tailGroups.length;
    if (gap < 0) return null;
    groups = [...head, ...Array(gap).fill(0), ...tailGroups];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  if (trailingV4.length) {
    groups[6] = trailingV4[0];
    groups[7] = trailingV4[1];
  }
  return groups;
}

function v4FromGroups(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function isPrivateV6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const allZeroThrough = (upTo: number) => groups.slice(0, upTo).every((g) => g === 0);

  // ::1 loopback and :: unspecified
  if (allZeroThrough(7) && (g7 === 1 || g7 === 0)) return true;

  // ::ffff:0:0/96 — an IPv4 address wearing a v6 costume
  if (allZeroThrough(5) && g5 === 0xffff) return isPrivateV4(v4FromGroups(g6, g7)) === true;

  // 64:ff9b::/96 NAT64, and 2002::/16 6to4 — both carry an IPv4 address inside
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateV4(v4FromGroups(g6, g7)) === true;
  }
  if (g0 === 0x2002) return isPrivateV4(v4FromGroups(g1, g2)) === true;

  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  return false;
}

/**
 * True for a private, loopback, link-local or otherwise reserved literal address.
 * False for a public literal AND for anything that is not an address at all — a
 * name has to be resolved before this question can be answered about it.
 */
export function isPrivateAddress(hostname: string): boolean {
  const host = unbracket(hostname);

  const v4 = isPrivateV4(host);
  if (v4 !== null) return v4;

  const groups = ipv6Groups(host);
  if (groups) return isPrivateV6(groups);

  return false;
}

/** True when the hostname is an address rather than a name, so DNS has nothing to add. */
export function isIpLiteral(hostname: string): boolean {
  const host = unbracket(hostname);
  return ipv4ToInt(host) !== null || ipv6Groups(host) !== null;
}

/** Names that resolve inward by convention, refused without waiting for DNS. */
export function isInternalName(hostname: string): boolean {
  const host = unbracket(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host === "metadata.google.internal"
  );
}
