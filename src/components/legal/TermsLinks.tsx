import type { LegalTerms } from "@/types";

function Document({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline">
      {children}
    </a>
  );
}

export function TermsLinks({ terms }: { terms: LegalTerms }) {
  return (
    <>
      the <Document href={terms.terms}>Terms of Service</Document> and the{" "}
      <Document href={terms.privacy}>Privacy Policy</Document>
    </>
  );
}
