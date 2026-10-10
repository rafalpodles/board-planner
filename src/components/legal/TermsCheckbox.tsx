import type { LegalTermsState } from "@/hooks/use-legal-terms";
import { TermsLinks } from "./TermsLinks";

/** Holds the form back while the terms are unknown: a server that publishes them refuses an account without them */
export const termsUnknown = (legal: LegalTermsState) => legal.terms === undefined;

export function TermsCheckbox({
  legal,
  checked,
  onChange,
}: {
  legal: LegalTermsState;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  if (legal.failed) {
    return (
      <p role="alert" className="text-sm text-danger" data-testid="terms-failed">
        The terms could not be loaded, so the account cannot be created yet.{" "}
        <button type="button" onClick={legal.retry} className="focus-ring underline">
          Try again
        </button>
      </p>
    );
  }
  if (!legal.terms) return null;
  return (
    <label className="flex items-start gap-2 text-sm" data-testid="accept-terms">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        required
        className="mt-1 h-4 w-4 shrink-0"
      />
      <span>
        I accept <TermsLinks terms={legal.terms} />.
      </span>
    </label>
  );
}
