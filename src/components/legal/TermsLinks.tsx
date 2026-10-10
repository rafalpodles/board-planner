import type { LegalTerms } from "@/types";

function Document({ href, polish, children }: { href: string; polish: string; children: React.ReactNode }) {
  return (
    <>
      <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
        {children}
      </a>{" "}
      <span className="text-text-muted">
        (
        <a href={polish} target="_blank" rel="noopener noreferrer" lang="pl" className="underline">
          Polski
        </a>
        )
      </span>
    </>
  );
}

export function TermsLinks({ terms }: { terms: LegalTerms }) {
  return (
    <>
      the{" "}
      <Document href={terms.terms} polish={terms.termsPl}>
        Terms of Service
      </Document>{" "}
      and the{" "}
      <Document href={terms.privacy} polish={terms.privacyPl}>
        Privacy Policy
      </Document>
    </>
  );
}
