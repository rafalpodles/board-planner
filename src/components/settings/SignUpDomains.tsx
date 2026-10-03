"use client";

import { FormEvent, useEffect, useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

interface SignUp {
  domains: string[];
  providers: string[];
  adminGroup: { group: string; provider: string } | null;
}

const asText = (domains: string[]) => domains.join(", ");

export function SignUpDomains() {
  const api = useApi();
  const { toast } = useToast();
  const [saved, setSaved] = useState<SignUp | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .get("/api/admin/sign-up")
      .then((data: SignUp) => {
        if (!Array.isArray(data?.domains)) throw new Error("unexpected answer");
        setSaved(data);
        setText(asText(data.domains));
      })
      .catch(() => setError("Could not load the sign-up domains."));
  }, [api]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const data: SignUp = await api.put("/api/admin/sign-up", {
        domains: text.split(/[\s,]+/).filter(Boolean),
      });
      setSaved(data);
      setText(asText(data.domains));
      toast("Sign-up domains saved", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the sign-up domains.");
    } finally {
      setSaving(false);
    }
  }

  if (!saved) return error ? <p className="mt-8 text-sm text-danger">{error}</p> : null;

  const providers = saved.providers.join(" or ");
  return (
    <section className="mt-8" aria-labelledby="sign-up-domains">
      <h2 id="sign-up-domains" className="text-lg font-semibold mb-1">
        Sign-up by domain
      </h2>
      <p className="text-sm text-text-muted mb-3">
        {providers
          ? `Anyone who signs in with ${providers} at one of these domains can make their own account, as a member with no boards.`
          : "Needs single sign-on or Google sign-in configured on this instance."}
        {saved.adminGroup &&
          ` Each sign-in with ${saved.adminGroup.provider} makes members of the group ${saved.adminGroup.group} administrators, and makes anyone else a member.`}
      </p>
      <form onSubmit={save} className="flex flex-col sm:flex-row gap-2 sm:items-end">
        <div className="flex-1">
          <Input
            label="Domains"
            placeholder="example.com, example.org"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={!providers}
            dirty={text !== asText(saved.domains)}
          />
        </div>
        <Button type="submit" variant="secondary" disabled={!providers || saving || text === asText(saved.domains)}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
