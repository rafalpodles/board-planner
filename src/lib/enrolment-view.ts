export const ENROLMENT_LABEL_MAX = 200;

export interface EnrolmentExpiry {
  expired: boolean;
  text: string;
}

export function normaliseEnrolmentLabel(raw: string): string {
  return raw.trim().slice(0, ENROLMENT_LABEL_MAX);
}

export function enrolmentMintBody(rawLabel: string): { label?: string } {
  const label = normaliseEnrolmentLabel(rawLabel);
  return label ? { label } : {};
}

export function enrolmentExpiry(expiresAt: string, now: number = Date.now()): EnrolmentExpiry {
  const deadline = new Date(expiresAt).getTime();
  if (Number.isNaN(deadline)) return { expired: true, text: "expiry unknown" };

  const remainingMs = deadline - now;
  if (remainingMs <= 0) return { expired: true, text: "expired" };

  const minutes = Math.floor(remainingMs / 60_000);
  if (minutes < 1) return { expired: false, text: "expires in under a minute" };
  return { expired: false, text: `expires in ${minutes} min` };
}
