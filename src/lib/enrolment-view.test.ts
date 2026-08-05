import { describe, it, expect } from "vitest";
import {
  ENROLMENT_LABEL_MAX,
  enrolmentExpiry,
  enrolmentMintBody,
  normaliseEnrolmentLabel,
} from "./enrolment-view";

const T0 = new Date("2026-08-03T12:00:00.000Z").getTime();
const expiresAt = new Date(T0 + 60 * 60_000).toISOString();

describe("normaliseEnrolmentLabel", () => {
  it("trims surrounding whitespace like the route does", () => {
    expect(normaliseEnrolmentLabel("  build-box-2  ")).toBe("build-box-2");
  });

  it("a whitespace-only label collapses to empty", () => {
    expect(normaliseEnrolmentLabel("   \n\t ")).toBe("");
  });

  it("truncates at the length the route stores", () => {
    const long = "x".repeat(ENROLMENT_LABEL_MAX + 50);
    expect(normaliseEnrolmentLabel(long)).toHaveLength(ENROLMENT_LABEL_MAX);
  });

  it("leaves a label at the limit untouched", () => {
    const exact = "y".repeat(ENROLMENT_LABEL_MAX);
    expect(normaliseEnrolmentLabel(exact)).toBe(exact);
  });
});

describe("enrolmentMintBody", () => {
  it("omits the label entirely when nothing was typed", () => {
    expect(enrolmentMintBody("")).toEqual({});
    expect(enrolmentMintBody("   ")).toEqual({});
  });

  it("sends the normalised label when one was typed", () => {
    expect(enrolmentMintBody("  laptop  ")).toEqual({ label: "laptop" });
  });
});

describe("enrolmentExpiry", () => {
  it("reports whole minutes left", () => {
    expect(enrolmentExpiry(expiresAt, T0)).toEqual({ expired: false, text: "expires in 60 min" });
    expect(enrolmentExpiry(expiresAt, T0 + 59 * 60_000)).toEqual({
      expired: false,
      text: "expires in 1 min",
    });
  });

  it("rounds down rather than claiming a minute that is nearly gone", () => {
    expect(enrolmentExpiry(expiresAt, T0 + 30_000)).toEqual({
      expired: false,
      text: "expires in 59 min",
    });
  });

  it("under a minute left is not rendered as 0 min", () => {
    expect(enrolmentExpiry(expiresAt, T0 + 60 * 60_000 - 5_000)).toEqual({
      expired: false,
      text: "expires in under a minute",
    });
  });

  it("is expired exactly at the deadline, not a moment after", () => {
    expect(enrolmentExpiry(expiresAt, T0 + 60 * 60_000)).toEqual({
      expired: true,
      text: "expired",
    });
  });

  it("stays expired once the deadline is past", () => {
    expect(enrolmentExpiry(expiresAt, T0 + 61 * 60_000)).toEqual({
      expired: true,
      text: "expired",
    });
  });

  it("an unparseable expiry is treated as expired, never as live", () => {
    expect(enrolmentExpiry("not-a-date", T0)).toEqual({ expired: true, text: "expiry unknown" });
  });
});
