import { notFound } from "next/navigation";
import { NotFoundProposals } from "@/components/not-found/NotFoundProposals";

// Visual proposals belong to the development checkout only.
export default function Preview404() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <NotFoundProposals />;
}
