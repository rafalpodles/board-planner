import type { LegalTerms } from "@/types";
import { TermsLinks } from "./TermsLinks";

export function TermsCheckbox({
  terms,
  checked,
  onChange,
}: {
  terms: LegalTerms | null | undefined;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  if (!terms) return null;
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
        I accept <TermsLinks terms={terms} />.
      </span>
    </label>
  );
}
