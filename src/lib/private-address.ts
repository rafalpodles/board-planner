type Cidr = [address: string, prefixBits: number];

const BLOCKED_V4: Cidr[] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback, all of it — not just 127.0.0.1
  ["169.254.0.0", 16], // link-local, incl. the cloud metadata address
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.31.196.0", 24], // AS112-v4
  ["192.52.193.0", 24], // AMT
  ["192.88.99.0", 24], // 6to4 relay anycast, deprecated
  ["192.175.48.0", 24], // direct delegation AS112
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
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

  if (allZeroThrough(6)) return true;

  if (allZeroThrough(5) && g5 === 0xffff) return isPrivateV4(v4FromGroups(g6, g7)) === true;

  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateV4(v4FromGroups(g6, g7)) === true;
  }
  if (g0 === 0x2002) return isPrivateV4(v4FromGroups(g1, g2)) === true;

  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true;

  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local, deprecated but still routed
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // 100::/64 discard-only

  if (g0 === 0x2001 && (g1 & 0xfe00) === 0) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true;

  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return true;
  if (g0 === 0x5f00) return true; // 5f00::/16 SRv6 SIDs, RFC 9602
  if (g0 === 0x2620 && g1 === 0x4f && g2 === 0x8000) return true; // 2620:4f:8000::/48 AS112-v6

  return false;
}

export function isPrivateAddress(hostname: string): boolean {
  const host = unbracket(hostname);

  const v4 = isPrivateV4(host);
  if (v4 !== null) return v4;

  const groups = ipv6Groups(host);
  if (groups) return isPrivateV6(groups);

  return false;
}

export function isIpLiteral(hostname: string): boolean {
  const host = unbracket(hostname);
  return ipv4ToInt(host) !== null || ipv6Groups(host) !== null;
}

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
