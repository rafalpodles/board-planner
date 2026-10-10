"use client";

import { useEffect, useState, FormEvent } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { APP_NAME } from "@/lib/brand";
import { latinFold } from "@/lib/identifiers";
import { useLegalTerms } from "@/hooks/use-legal-terms";
import { TermsCheckbox } from "@/components/legal/TermsCheckbox";

interface Organisation {
  id: string;
  name: string;
  origin: string;
}

type Step =
  | { name: "email" }
  | { name: "code"; email: string }
  | { name: "organisations"; email: string; organisations: Organisation[]; passwordSignIn: boolean }
  | { name: "password"; email: string; organisation: Organisation; organisations: Organisation[]; passwordSignIn: boolean }
  | { name: "create"; email: string; organisations: Organisation[]; passwordSignIn: boolean };

const slugFrom = (name: string) =>
  latinFold(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");

async function send(path: string, method: string, body?: unknown) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

const hostOf = (origin: string) => new URL(origin).host;

function RememberCheckbox({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-start gap-2 text-sm" data-testid="remember-organisation">
      <input
        id="remember-organisation"
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby="remember-organisation-note"
        className="mt-1 h-4 w-4 shrink-0"
      />
      <div>
        <label htmlFor="remember-organisation">Open this organisation straight away next time</label>
        <p id="remember-organisation-note" className="text-xs text-text-muted">
          Keeps a cookie on this device for 180 days. Leave it unticked and nothing is kept.
        </p>
      </div>
    </div>
  );
}

export function PlatformSignIn() {
  const [step, setStep] = useState<Step>({ name: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [domain, setDomain] = useState("");
  const [orgName, setOrgName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [remember, setRemember] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  const [switching, setSwitching] = useState(false);
  const terms = useLegalTerms();

  useEffect(() => {
    setRemember(false);
  }, [step]);

  useEffect(() => {
    setSwitching(new URLSearchParams(window.location.search).has("switch"));
  }, []);

  const forget = () =>
    void run(async () => {
      const { ok, data } = await send("/api/sign-in/remembered", "DELETE");
      if (!ok) return setError(data.error ?? "Could not forget the organisation. Try again.");
      setForgotten(true);
    });

  async function run(work: () => Promise<void>) {
    setError("");
    setBusy(true);
    try {
      await work();
    } catch {
      setError("Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function backToEmail() {
    setCode("");
    setUsername("");
    setPassword("");
    setError("");
    setStep({ name: "email" });
  }

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { ok, data } = await send("/api/sign-in/start", "POST", { email });
      if (!ok) return setError(data.error ?? "Could not send a code.");
      setCode("");
      setStep({ name: "code", email: email.trim().toLowerCase() });
    });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { ok, data } = await send("/api/sign-in/verify", "POST", { code });
      if (data.restart) {
        backToEmail();
        return setError(data.error);
      }
      if (!ok) return setError(data.error ?? "That code did not work.");
      const organisations: Organisation[] = data.organisations ?? [];
      const passwordSignIn = data.passwordSignIn !== false;
      setDomain(data.domain ?? "");
      if (organisations.length === 1) {
        setStep({ name: "password", email: data.email, organisation: organisations[0], organisations, passwordSignIn });
      } else {
        setStep({ name: "organisations", email: data.email, organisations, passwordSignIn });
      }
    });
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    if (step.name !== "password") return;
    void run(async () => {
      const { ok, data } = await send("/api/sign-in/password", "POST", {
        organisation: step.organisation.id,
        password,
        remember,
      });
      if (data.restart) {
        backToEmail();
        return setError(data.error);
      }
      if (!ok) return setError(data.error ?? "Could not sign in.");
      window.location.assign(data.location);
    });
  };

  const startCreating = () => {
    if (step.name !== "organisations" && step.name !== "password") return;
    setError("");
    setPassword("");
    if (!username) {
      setUsername(
        latinFold(step.email.split("@")[0].split("+")[0])
          .toLowerCase()
          .replace(/[^a-z0-9._-]/g, "")
          .replace(/^[._-]+/, "")
          .slice(0, 32)
      );
    }
    setStep({ name: "create", email: step.email, organisations: step.organisations, passwordSignIn: step.passwordSignIn });
  };

  const submitCreate = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const { ok, data } = await send("/api/sign-in/organisation", "POST", { name: orgName, slug, fullName, username, password, acceptTerms, remember });
      if (data.restart) {
        backToEmail();
        return setError(data.error);
      }
      if (!ok) return setError(data.error ?? "Could not create the organisation.");
      window.location.assign(data.location);
    });
  };

  return (
    <div className="flex items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-sm" data-testid="platform-sign-in">
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo.svg" alt={APP_NAME} width={48} height={48} className="mb-3" />
          <h1 className="text-2xl font-bold text-center">{step.name === "create" ? "Create an organisation" : `Sign in to ${APP_NAME}`}</h1>
        </div>

        {error && (
          <p role="alert" data-testid="sign-in-error" className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm">
            {error}
          </p>
        )}

        {step.name === "email" && (
          <form onSubmit={submitEmail} className="space-y-4">
            <Input
              label="E-mail address"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              autoFocus
            />
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Sending…" : "Continue"}
            </Button>
            <p className="text-xs text-text-muted">We will e-mail you a code. You never need your organisation&apos;s address to sign in.</p>
            {switching && (
              <div className="border-t border-border pt-3 text-sm">
                {forgotten ? (
                  <p role="status" data-testid="remembered-forgotten">Nothing is remembered on this device any more.</p>
                ) : (
                  <button type="button" onClick={forget} disabled={busy} className="focus-ring min-h-[44px] w-full text-text-muted underline">
                    Stop opening my last organisation automatically
                  </button>
                )}
              </div>
            )}
          </form>
        )}

        {step.name === "code" && (
          <form onSubmit={submitCode} className="space-y-4">
            <p className="text-sm">
              We sent a code to <strong className="break-all">{step.email}</strong>.
            </p>
            <Input
              label="Code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              autoFocus
            />
            <Button type="submit" className="w-full" disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Continue"}
            </Button>
            <button type="button" onClick={backToEmail} className="focus-ring w-full text-sm text-text-muted underline">
              Use another e-mail address
            </button>
          </form>
        )}

        {step.name === "organisations" && (
          <div className="space-y-3">
            {step.organisations.length === 0 ? (
              <p className="text-sm" data-testid="no-organisations">
                No organisation has confirmed <strong className="break-all">{step.email}</strong> as an account&apos;s
                address. If you have an account, sign in on your organisation&apos;s own address and confirm your
                e-mail there.
              </p>
            ) : (
              <>
                <p className="text-sm">Choose an organisation:</p>
                <ul className="space-y-2" data-testid="organisation-choices">
                  {step.organisations.map((organisation) => (
                    <li key={organisation.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setPassword("");
                          setError("");
                          setStep({ name: "password", email: step.email, organisation, organisations: step.organisations, passwordSignIn: step.passwordSignIn });
                        }}
                        className="focus-ring flex min-h-[44px] w-full min-w-0 flex-col items-start rounded-lg border border-border px-4 py-2 text-left hover:bg-bg-hover"
                      >
                        <span className="w-full truncate text-sm font-medium">{organisation.name}</span>
                        <span className="w-full truncate text-xs text-text-muted">{hostOf(organisation.origin)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {step.passwordSignIn && (
              <Button type="button" variant={step.organisations.length === 0 ? "primary" : "secondary"} className="w-full" onClick={startCreating}>
                Create an organisation
              </Button>
            )}
            <button type="button" onClick={backToEmail} className="focus-ring w-full text-sm text-text-muted underline">
              Use another e-mail address
            </button>
          </div>
        )}

        {step.name === "create" && (
          <form onSubmit={submitCreate} className="space-y-4" data-testid="create-organisation">
            <p className="text-sm break-words">
              A new organisation, with <strong className="break-all">{step.email}</strong> as its first administrator.
            </p>
            <Input
              label="Organisation name"
              value={orgName}
              maxLength={80}
              onChange={(e) => {
                setOrgName(e.target.value);
                if (!slugEdited) setSlug(slugFrom(e.target.value));
              }}
              required
              autoFocus
            />
            <div>
              <Input
                label="Organisation address"
                value={slug}
                maxLength={40}
                onChange={(e) => {
                  setSlugEdited(true);
                  setSlug(e.target.value.toLowerCase());
                }}
                aria-describedby="organisation-address-hint"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
              <p id="organisation-address-hint" className="mt-1 break-all text-xs text-text-muted">
                {slug ? `${slug}.${domain}` : `Letters, digits and hyphens, then .${domain}`}
              </p>
            </div>
            <Input label="Your name" value={fullName} maxLength={80} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required />
            <Input label="Username" value={username} maxLength={32} onChange={(e) => setUsername(e.target.value.toLowerCase())} autoComplete="username" required />
            <Input label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
            <TermsCheckbox terms={terms} checked={acceptTerms} onChange={setAcceptTerms} />
            <RememberCheckbox checked={remember} onChange={setRemember} />
            <Button type="submit" className="w-full" disabled={busy || terms === undefined}>
              {busy ? "Creating…" : "Create the organisation"}
            </Button>
            <button
              type="button"
              onClick={() => {
                setError("");
                setStep(
                  step.organisations.length === 1
                    ? { name: "password", email: step.email, organisation: step.organisations[0], organisations: step.organisations, passwordSignIn: step.passwordSignIn }
                    : { name: "organisations", email: step.email, organisations: step.organisations, passwordSignIn: step.passwordSignIn }
                );
              }}
              className="focus-ring w-full text-sm text-text-muted underline"
            >
              Back
            </button>
          </form>
        )}

        {step.name === "password" && !step.passwordSignIn && (
          <div className="space-y-3">
            <p className="text-sm break-words">
              <strong>{step.organisation.name}</strong> signs in through its own page.
            </p>
            <a
              href={`${step.organisation.origin}/login`}
              className="focus-ring flex min-h-[44px] w-full items-center justify-center rounded-lg bg-primary-solid px-4 py-2 text-sm font-medium text-white hover:bg-primary-solid-hover"
            >
              Continue on {hostOf(step.organisation.origin)}
            </a>
            <button type="button" onClick={backToEmail} className="focus-ring w-full text-sm text-text-muted underline">
              Use another e-mail address
            </button>
          </div>
        )}

        {step.name === "password" && step.passwordSignIn && (
          <form onSubmit={submitPassword} className="space-y-4">
            <p className="text-sm break-words">
              Signing in to <strong>{step.organisation.name}</strong>{" "}
              <span className="text-text-muted">({hostOf(step.organisation.origin)})</span> as{" "}
              <strong className="break-all">{step.email}</strong>.
            </p>
            <Input
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              autoFocus
            />
            <RememberCheckbox checked={remember} onChange={setRemember} />
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </Button>
            <p className="flex flex-wrap justify-between gap-2 text-sm">
              <a href={`${step.organisation.origin}/login`} className="focus-ring text-text-muted underline">
                Sign in another way
              </a>
              <a href={`${step.organisation.origin}/forgot`} className="focus-ring text-text-muted underline">
                Forgot password?
              </a>
            </p>
            {step.organisations.length > 1 && (
              <button
                type="button"
                onClick={() => setStep({ name: "organisations", email: step.email, organisations: step.organisations, passwordSignIn: step.passwordSignIn })}
                className="focus-ring w-full text-sm text-text-muted underline"
              >
                Choose another organisation
              </button>
            )}
            <button type="button" onClick={backToEmail} className="focus-ring w-full text-sm text-text-muted underline">
              Use another e-mail address
            </button>
            <button type="button" onClick={startCreating} className="focus-ring w-full text-sm text-text-muted underline">
              Create another organisation
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
