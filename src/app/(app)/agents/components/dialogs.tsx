"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { Select } from "@/components/ui/Select";
import { CAPABILITIES, GATE_KINDS, MODELS, gateKindByKey } from "../catalog";
import { NewAgent, NewBlock } from "../store";
import { ApiAgentBlock } from "@/types";

const MINE = "mine";

// Owns the failure, so every dialog that uses it gets one. Each onCreate awaits a write and then
// closes; without a catch here a refusal was an unhandled rejection — the dialog stayed open with
// the typed prompt still in it, the button re-enabled, and nothing said why (BP-345 review).
function Footer({
  onCancel,
  onCreate,
  disabled,
  busy,
  onBusy,
}: {
  onCancel: () => void;
  onCreate: () => Promise<void> | void;
  disabled: boolean;
  busy: boolean;
  onBusy: (busy: boolean) => void;
}) {
  const [error, setError] = useState("");

  // `busy` is the dialog's rather than this footer's: the write is in flight for the whole dialog,
  // and the dialog is what has to stay on screen until it lands — a footer that owned it could
  // disable its own Cancel while the backdrop still dismissed everything (BP-565).
  return (
    <>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          disabled={disabled || busy}
          onClick={async () => {
            setError("");
            onBusy(true);
            try {
              await onCreate();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not create");
            } finally {
              onBusy(false);
            }
          }}
        >
          {busy ? "Creating…" : "Create"}
        </Button>
      </div>
    </>
  );
}

export function NewAgentDialog({
  open,
  projects,
  onClose,
  onCreate,
}: {
  open: boolean;
  projects: { _id: string; name: string }[];
  onClose: () => void;
  onCreate: (agent: NewAgent) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState(MINE);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setName("");
    setDescription("");
    setScope(MINE);
    setBusy(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={close} closeDisabled={busy} title="New agent">
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Careful with migrations"
          autoFocus
          required
        />
        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="When you would reach for this one"
          rows={3}
        />
        <Select
          label="Who can use it"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          options={[
            { value: MINE, label: "Only me" },
            ...projects.map((p) => ({ value: p._id, label: `Everyone on ${p.name}` })),
          ]}
        />
        <Footer
          onCancel={close}
          busy={busy}
          onBusy={setBusy}
          disabled={!name.trim()}
          onCreate={async () => {
            await onCreate({
              name: name.trim(),
              description: description.trim(),
              projectId: scope === MINE ? undefined : scope,
            });
            close();
          }}
        />
      </div>
    </Modal>
  );
}

export function NewGateDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (block: NewBlock) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [gateKind, setGateKind] = useState(GATE_KINDS[0].key);
  const [params, setParams] = useState<Record<string, string>>(GATE_KINDS[0].defaults);
  const [busy, setBusy] = useState(false);
  const kind = gateKindByKey(gateKind);

  const close = () => {
    setName("");
    setGateKind(GATE_KINDS[0].key);
    setParams(GATE_KINDS[0].defaults);
    setBusy(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={close} closeDisabled={busy} title="New gate">
      <div className="flex flex-col gap-4">
        <Select
          label="What it checks"
          value={gateKind}
          onChange={(e) => {
            setGateKind(e.target.value);
            setParams(gateKindByKey(e.target.value)?.defaults ?? {});
          }}
          options={GATE_KINDS.map((k) => ({ value: k.key, label: k.name }))}
        />
        <p className="-mt-2 text-[12px] text-text-muted">{kind?.description}</p>

        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind ? `${kind.name}, stricter` : ""}
          required
        />

        {kind?.params.map((param) =>
          param.type === "select" ? (
            <Select
              key={param.key}
              label={param.label}
              value={params[param.key] ?? param.options?.[0]?.value ?? ""}
              onChange={(e) => setParams((v) => ({ ...v, [param.key]: e.target.value }))}
              options={param.options ?? []}
            />
          ) : (
            <div key={param.key}>
              <Input
                label={param.label}
                type={param.type === "number" ? "number" : "text"}
                value={params[param.key] ?? ""}
                placeholder={param.placeholder}
                onChange={(e) => setParams((v) => ({ ...v, [param.key]: e.target.value }))}
              />
              {param.hint && <p className="mt-1 text-[12px] text-text-muted">{param.hint}</p>}
            </div>
          )
        )}

        {kind?.params.length === 0 && (
          <p className="text-[12px] text-text-muted">This one has nothing to set.</p>
        )}

        <Footer
          onCancel={close}
          busy={busy}
          onBusy={setBusy}
          disabled={!name.trim()}
          onCreate={async () => {
            await onCreate({
              kind: "gate",
              name: name.trim(),
              description: kind?.description ?? "",
              gateKind,
              params,
            });
            close();
          }}
        />
      </div>
    </Modal>
  );
}

export function NewStepDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (block: NewBlock) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [capability, setCapability] = useState<string>(CAPABILITIES[0].value);
  const [model, setModel] = useState<string>(MODELS[0].value);
  const [busy, setBusy] = useState(false);

  const close = () => {
    setName("");
    setDescription("");
    setPrompt("");
    setCapability(CAPABILITIES[0].value);
    setModel(MODELS[0].value);
    setBusy(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={close} closeDisabled={busy} title="New step">
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Write the tests"
          autoFocus
          required
        />
        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="One line, so it reads in a list"
          rows={2}
        />
        <Textarea
          label="What it should do"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Read the change already committed and write tests that would have caught it failing."
          rows={4}
        />
        <Select
          label="Model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          options={MODELS.map((m) => ({ value: m.value, label: m.label }))}
        />
        <div>
          <Select
            label="What it may touch"
            value={capability}
            onChange={(e) => setCapability(e.target.value)}
            options={CAPABILITIES.map((c) => ({ value: c.value, label: c.label }))}
          />
          <p className="mt-1 text-[12px] text-text-muted">
            {CAPABILITIES.find((c) => c.value === capability)?.hint}
          </p>
        </div>

        <Footer
          onCancel={close}
          busy={busy}
          onBusy={setBusy}
          disabled={!name.trim()}
          onCreate={async () => {
            await onCreate({
              kind: "step",
              name: name.trim(),
              description: description.trim(),
              prompt: prompt.trim(),
              capability,
              model,
            });
            close();
          }}
        />
      </div>
    </Modal>
  );
}

function Choice({
  label,
  value,
  options,
  readOnly,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  if (readOnly) {
    const shown = options.find((o) => o.value === value)?.label ?? value;
    return <Input label={label} value={shown} readOnly />;
  }
  return (
    <Select label={label} value={value} onChange={(e) => onChange(e.target.value)} options={options} />
  );
}

/**
 * Editing never touches the key. The key is what an agent's composition names and what the worker
 * resolves against its own source, so a rename here changes the label and nothing else.
 */
export function EditBlockDialog({
  block,
  readOnly = false,
  onClose,
  onSave,
}: {
  block: ApiAgentBlock | null;
  readOnly?: boolean;
  onClose: () => void;
  onSave: (blockId: string, patch: Partial<NewBlock>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [capability, setCapability] = useState("");
  const [model, setModel] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // A dialog keyed on the row it edits: the fields reset when a different block opens it
  useEffect(() => {
    if (!block) return;
    setName(block.name);
    setDescription(block.description);
    setPrompt(block.prompt);
    setCapability(block.capability);
    setModel(block.model);
    setParams(block.params ?? {});
    setError("");
    setBusy(false);
  }, [block]);

  if (!block) return null;
  const kind = block.gateKind ? gateKindByKey(block.gateKind) : undefined;
  const callsModel = block.kind === "step" && !block.deterministic;
  const modelOptions: { value: string; label: string }[] = MODELS.map((m) => ({
    value: m.value,
    label: m.label,
  }));
  if (!modelOptions.some((m) => m.value === block.model)) {
    modelOptions.unshift({ value: block.model, label: block.model || "The worker's own" });
  }
  // A value stored through the API may be one the form does not offer; shown, not swapped for the first
  const withStored = (options: { value: string; label: string }[], stored?: string) =>
    stored && !options.some((o) => o.value === stored)
      ? [{ value: stored, label: stored }, ...options]
      : options;

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={busy}
      title={block.builtIn ? `${block.name} (default)` : block.name}
    >
      <div className="flex flex-col gap-4">
        {readOnly && (
          <p className="text-[13px] text-text-muted">
            An instance admin changes {block.kind === "step" ? "steps" : "gates"}. You can read this
            one here.
          </p>
        )}
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          readOnly={readOnly}
          required={!readOnly}
        />
        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          readOnly={readOnly}
          rows={2}
        />

        {callsModel && (
          <>
            <Textarea
              label="What it should do"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              readOnly={readOnly}
              rows={4}
            />
            <Choice
              label="Model"
              value={model}
              onChange={setModel}
              readOnly={readOnly}
              options={modelOptions}
            />
            <div>
              <Choice
                label="What it may touch"
                value={capability}
                onChange={setCapability}
                readOnly={readOnly}
                options={CAPABILITIES.map((c) => ({ value: c.value, label: c.label }))}
              />
              <p className="mt-1 text-[12px] text-text-muted">
                {CAPABILITIES.find((c) => c.value === capability)?.hint}
              </p>
            </div>
          </>
        )}

        {block.kind === "step" && block.deterministic && (
          <p className="text-[12px] text-text-muted">
            This one is an action the worker takes. It has no prompt and calls no model.
          </p>
        )}

        {block.kind === "gate" &&
          kind?.params.map((param) =>
            param.type === "select" ? (
              <Choice
                key={param.key}
                label={param.label}
                value={params[param.key] ?? param.options?.[0]?.value ?? ""}
                onChange={(value) => setParams((v) => ({ ...v, [param.key]: value }))}
                readOnly={readOnly}
                options={withStored(param.options ?? [], block.params?.[param.key])}
              />
            ) : (
              <div key={param.key}>
                <Input
                  label={param.label}
                  type={param.type === "number" ? "number" : "text"}
                  value={params[param.key] ?? ""}
                  placeholder={param.placeholder}
                  onChange={(e) => setParams((v) => ({ ...v, [param.key]: e.target.value }))}
                  readOnly={readOnly}
                />
                {param.hint && <p className="mt-1 text-[12px] text-text-muted">{param.hint}</p>}
              </div>
            )
          )}

        {error && (
          <p role="alert" className="text-[13px] text-danger">
            {error}
          </p>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {readOnly ? "Done" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button
              disabled={!name.trim() || busy}
              onClick={async () => {
                setError("");
                setBusy(true);
                try {
                  await onSave(block._id, {
                    name: name.trim(),
                    description: description.trim(),
                    ...(block.kind === "gate" ? { params } : { prompt: prompt.trim() }),
                    ...(callsModel && model !== block.model ? { model } : {}),
                    ...(callsModel && capability !== block.capability ? { capability } : {}),
                  });
                  onClose();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Could not save");
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Saving…" : "Save"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
