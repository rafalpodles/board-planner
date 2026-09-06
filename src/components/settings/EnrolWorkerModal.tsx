"use client";

import { useState } from "react";
import { useApi } from "@/hooks/use-api";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { enrolmentExpiry, enrolmentMintBody, ENROLMENT_LABEL_MAX } from "@/lib/enrolment-view";

interface MintedEnrolment {
  token: string;
  expiresAt: string;
}

interface EnrolWorkerModalProps {
  open: boolean;
  onClose: () => void;
}

export function EnrolWorkerModal({ open, onClose }: EnrolWorkerModalProps) {
  const api = useApi();
  const { toast } = useToast();

  const [label, setLabel] = useState("");
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<MintedEnrolment | null>(null);
  const [copied, setCopied] = useState(false);

  async function mint() {
    setMinting(true);
    try {
      const res: MintedEnrolment = await api.post(
        "/api/workers/enrolment",
        enrolmentMintBody(label)
      );
      setMinted(res);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not mint an enrolment token", "error");
    } finally {
      setMinting(false);
    }
  }

  async function copy() {
    if (!minted) return;
    try {
      await navigator.clipboard.writeText(minted.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("Copy failed — select the token and copy it manually", "error");
    }
  }

  function close() {
    setMinted(null);
    setLabel("");
    setCopied(false);
    onClose();
  }

  const expiry = minted ? enrolmentExpiry(minted.expiresAt) : null;

  return (
    <Modal open={open} onClose={close} closeDisabled={minting} title="Enrol a worker" size="lg">
      {!minted ? (
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            A worker registers itself with a single-use enrolment token instead of an admin
            credential. The token is good for one hour and for one registration.
          </p>
          <Input
            label="Label (optional)"
            value={label}
            maxLength={ENROLMENT_LABEL_MAX}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Which machine is this for? e.g. build-box-2"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !minting) {
                e.preventDefault();
                mint();
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={close} disabled={minting}>
              Cancel
            </Button>
            <Button onClick={mint} disabled={minting}>
              {minting ? "Minting…" : "Mint token"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-warning/10 border border-warning/30 rounded-lg p-4">
            <p className="text-sm font-medium text-warning mb-2">
              Copy this token now — it is shown once and cannot be retrieved again. Only its hash is
              stored, and the first worker that registers with it spends it.
            </p>
            <div className="flex gap-2">
              <code className="flex-1 bg-bg text-sm px-3 py-2 rounded border border-border break-all select-all">
                {minted.token}
              </code>
              <Button size="sm" variant="secondary" onClick={copy}>
                {copied ? "Copied!" : "Copy"}
              </Button>
            </div>
            <p className={`text-xs mt-2 ${expiry?.expired ? "text-danger" : "text-text-muted"}`}>
              Single use · {expiry?.text} (
              {new Date(minted.expiresAt).toLocaleTimeString()})
            </p>
          </div>

          <div className="border border-border rounded-lg p-4 space-y-3 text-sm">
            <p className="font-medium">On the worker machine</p>
            <ol className="list-decimal pl-5 space-y-2 text-text-muted">
              <li>
                Write the token to a file the worker can read and point{" "}
                <code className="text-text">CP_ENROLMENT_TOKEN_FILE</code> at it. The worker deletes
                that file once it has registered, and never needs it again.
              </li>
              <li>
                Scope the worker&apos;s own <code className="text-text">CP_API_TOKEN</code> to the
                projects it serves. That token is a separate credential and it sits on a disk the
                coding agent can read — an unscoped admin token there would let the agent lift its
                own kill switch, which is the whole reason enrolment tokens exist.
              </li>
            </ol>
          </div>

          <div className="flex justify-end">
            <Button variant="secondary" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
