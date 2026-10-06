import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PlatformSignIn } from "@/components/auth/PlatformSignIn";
import { isPlatformHost } from "@/lib/organisation-host";

export default async function Home() {
  if (isPlatformHost((await headers()).get("host"))) return <PlatformSignIn />;
  redirect("/projects");
}
