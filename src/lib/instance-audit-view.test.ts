import { describe, it, expect } from "vitest";
import { auditActionLabel, auditActor, auditIsNotable } from "./instance-audit-view";
import { INSTANCE_AUDIT_ACTIONS, InstanceAuditAction } from "@/types";

const entry = (action: InstanceAuditAction, detail = "") => ({ action, detail });

describe("auditActionLabel", () => {
  // The guard the bug was really about. Two of the eighteen actions had no label and rendered as
  // "worker command sent" — the identifier with its underscores swapped for spaces, which reads as
  // a leak of the schema rather than as one of this page's own sentences. Naming the two would fix
  // today and let the nineteenth ship the same way.
  it("gives every action this build declares a label of its own", () => {
    const fallbacks = INSTANCE_AUDIT_ACTIONS.filter(
      (action) => auditActionLabel(entry(action)) === action.replace(/_/g, " ")
    );
    expect(fallbacks, "these actions render as their own identifier").toEqual([]);
  });

  it("names which command was sent, rather than that one was", () => {
    expect(auditActionLabel(entry("worker_command_sent", "stop"))).toBe("Worker told to stop");
    expect(auditActionLabel(entry("worker_command_sent", "pause"))).toBe("Worker told to pause");
    expect(auditActionLabel(entry("worker_command_sent", "resume"))).toBe("Worker told to resume");
  });

  // A row written by a newer deployment against the same database: the command is one this build
  // has never heard of, and the honest answer is the sentence without the verb
  it("still reads as a sentence when the command is unknown", () => {
    expect(auditActionLabel(entry("worker_command_sent", "hibernate"))).toBe(
      "Command sent to a worker"
    );
  });

  it("keeps the labels the page already had", () => {
    expect(auditActionLabel(entry("worker_locked"))).toBe("Kill switch on");
    expect(auditActionLabel(entry("enrolment_token_minted"))).toBe("Enrolment token minted");
  });
});

describe("auditIsNotable", () => {
  // The pairing the bug named: two ways to stop a machine, one of them drawn in red and the other
  // as quiet as a rename
  it("marks a stop as loudly as the kill switch beside it", () => {
    expect(auditIsNotable(entry("worker_command_sent", "stop"))).toBe(true);
    expect(auditIsNotable(entry("worker_locked"))).toBe(true);
  });

  it("marks a pause too, because it also takes work off the machine", () => {
    expect(auditIsNotable(entry("worker_command_sent", "pause"))).toBe(true);
  });

  // The control for the three above: if everything about a command were notable, none of them
  // would mean anything
  it("leaves a resume quiet, because it gives the work back", () => {
    expect(auditIsNotable(entry("worker_command_sent", "resume"))).toBe(false);
  });

  it("leaves the ordinary rows quiet", () => {
    expect(auditIsNotable(entry("worker_renamed"))).toBe(false);
    expect(auditIsNotable(entry("worker_poll_interval_changed"))).toBe(false);
    expect(auditIsNotable(entry("project_workers_enabled"))).toBe(false);
  });
});

/**
 * BP-539. The reference stops naming anybody the moment that account is deleted, so the stored
 * username comes first — and the order is the whole fix, not a preference.
 */
describe("auditActor", () => {
  const actor = { _id: "u1", username: "rafal", fullName: "Rafal" };

  it("names the account that wrote the row after that account is deleted", () => {
    expect(auditActor({ actorUsername: "rafal", user: null })).toBe("rafal");
  });

  // Written before the field existed: the reference is all there is, and while it resolves it is
  // still the right answer
  it("falls back to the reference for a row that predates the stored name", () => {
    expect(auditActor({ actorUsername: undefined, user: actor })).toBe("rafal");
  });

  // The control, and the reason the order matters: this is what a machine's row looks like, and
  // what a deleted actor's row used to look like
  it("says system only when there is nobody to name", () => {
    expect(auditActor({ actorUsername: "", user: null })).toBe("system");
  });

  // The stored name wins, because the reference is the one that can go
  it("prefers the stored name over the reference", () => {
    expect(auditActor({ actorUsername: "rafal", user: { ...actor, username: "someone-else" } })).toBe(
      "rafal"
    );
  });
});

describe("auditIsNotable", () => {
  // Being made an administrator is the escalation this route gates on `viaMachineCredential`, and
  // a deletion cannot be undone. Creation is routine and deliberately stays quiet — the row is
  // there to be found, not to be spotted.
  it("marks a role change and a deletion, and leaves a creation quiet", () => {
    expect(auditIsNotable(entry("user_role_changed"))).toBe(true);
    expect(auditIsNotable(entry("user_deleted"))).toBe(true);
    expect(auditIsNotable(entry("user_created"))).toBe(false);
  });
});
