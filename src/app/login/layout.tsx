import { OrganisationHostGate } from "@/components/auth/OrganisationHostGate";

export default function Layout({ children }: { children: React.ReactNode }) {
  return <OrganisationHostGate>{children}</OrganisationHostGate>;
}
