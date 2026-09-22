// A worker reports why it could not bind each project as one line, "; "-joined, each entry
// "<projectId>: <reason>" (worker/src/wiring.ts, rebind). Only an entry for this project says
// anything about it.
const NEXT_ENTRY = /; [0-9a-f]{24}: /;

export function bindingErrorFor(bindingError: string | null | undefined, projectId: string): string {
  if (!bindingError || !projectId) return "";
  const marker = `${projectId}: `;
  let from = -1;
  for (let at = bindingError.indexOf(marker); at !== -1; at = bindingError.indexOf(marker, at + 1)) {
    if (at === 0 || bindingError.startsWith("; ", at - 2)) {
      from = at + marker.length;
      break;
    }
  }
  if (from === -1) return "";
  const rest = bindingError.slice(from);
  const next = rest.search(NEXT_ENTRY);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

/** The worker's reason, said as what to do about it on the machine. */
export function describeBindingError(reason: string): string {
  const sensitive = /is under the sensitive directory (\S+)/.exec(reason);
  if (sensitive) {
    return `its checkout is in ${sensitive[1]}, a directory the worker refuses to work in. Move the checkout somewhere else, such as your home folder, and update repos.json on that machine.`;
  }
  if (/is not approved on this machine/.test(reason)) {
    return "its checkout is not listed in repos.json on that machine. Add it there.";
  }
  if (/^no checkout of \S+ on this machine/.test(reason)) {
    return "it has no checkout of this board's repository listed in repos.json. Clone the repository and add it there.";
  }
  if (/is group- or world-writable/.test(reason)) {
    return "its checkout can be written by other users on that machine. Remove their write access (chmod go-w).";
  }
  if (/is not owned by this worker/.test(reason)) {
    return "its checkout belongs to a different user account on that machine. Use a checkout of your own.";
  }
  return `the worker refused its checkout: ${reason}`;
}
