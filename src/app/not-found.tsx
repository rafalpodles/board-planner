import { headers } from "next/headers";
import AppLayout from "./(app)/layout";
import { NotFoundExperience } from "@/components/not-found/NotFoundExperience";
import { OrganisationSuspended } from "@/components/OrganisationSuspended";
import { organisationOfRequest, platformSignInOrigin } from "@/lib/organisation-host";
import { isDatabaseUnreachable } from "@/lib/db-errors";
import { HostUnavailable } from "@/components/not-found/HostUnavailable";

export default async function NotFound() {
  const requestHeaders = await headers();
  // Use only the host resolver's trusted Host handling; never interpolate the requested
  // URL into a link or expose the organisation's stored name on an unknown address.
  let host;
  try {
    host = await organisationOfRequest(new Request("http://localhost", { headers: requestHeaders }));
  } catch (error) {
    if (isDatabaseUnreachable(error)) return <HostUnavailable />;
    throw error;
  }
  if (host.kind === "suspended") return <OrganisationSuspended />;
  if (host.kind === "none") return <NotFoundExperience kind="organisation" standalone signIn={platformSignInOrigin()} />;
  if (host.kind === "platform") return <NotFoundExperience standalone actionHref="/?switch" actionLabel="Back to sign in" />;
  return <AppLayout><NotFoundExperience /></AppLayout>;
}
