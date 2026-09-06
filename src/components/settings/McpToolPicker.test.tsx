// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { McpToolPicker, carriedTools, parseAllowlist } from "./McpToolPicker";

afterEach(cleanup);

const CATALOG = [
  { name: "notion-search", description: "Search pages in the workspace", readSafe: true },
  { name: "notion-fetch", description: "Read one page", readSafe: true },
  { name: "notion-update-page", description: "Append blocks to a page", readSafe: false },
];

// `null`, not `undefined`: passing undefined would silently fall back to the default parameter
// and the "never tested" case below would quietly test the opposite of what it says.
function setup(allowlist = "", catalog: typeof CATALOG | null = CATALOG, allowWrites = true) {
  const onChange = vi.fn();
  render(
    <McpToolPicker
      rowName="notion"
      catalog={catalog ?? undefined}
      allowlist={allowlist}
      allowWrites={allowWrites}
      onChange={onChange}
    />
  );
  return onChange;
}

describe("McpToolPicker", () => {
  it("shows each tool's description, so the list can be chosen from without knowing it", () => {
    setup();

    expect(screen.getByText("Search pages in the workspace")).toBeTruthy();
    expect(screen.getByText("Append blocks to a page")).toBeTruthy();
  });

  it("marks the tools that write", () => {
    setup();

    const marks = screen.getAllByText("writes");
    expect(marks).toHaveLength(1);
  });

  it("ticking a tool adds its name to the stored comma-separated list", () => {
    const onChange = setup("notion-search");

    fireEvent.click(screen.getByLabelText("notion-fetch for notion"));

    expect(onChange).toHaveBeenCalledWith("notion-search, notion-fetch");
  });

  it("unticking removes it", () => {
    const onChange = setup("notion-search, notion-fetch");

    fireEvent.click(screen.getByLabelText("notion-search for notion"));

    expect(onChange).toHaveBeenCalledWith("notion-fetch");
  });

  it("reflects an allowlist written before this existed, without rewriting it", () => {
    setup("notion-fetch");

    expect((screen.getByLabelText("notion-fetch for notion") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("notion-search for notion") as HTMLInputElement).checked).toBe(false);
  });

  /**
   * An empty allowlist is every tool the server has, not none. Reading it as zero is the exact
   * misunderstanding that let 86 tools into every call on BP.
   */
  it("counts an empty allowlist as the whole catalogue, not as nothing", () => {
    setup("");

    expect(screen.getByText(/Nothing ticked, so every tool this server offers is used/)).toBeTruthy();
    // Plain digits, not toLocaleString: the grouping separator follows the runner's locale, so
    // "1,050" passes in en-US and fails in pl-PL (BP-569 review).
    expect(screen.getByText(/3 carried per turn, roughly 1050 tokens/)).toBeTruthy();
  });

  it("counts the ticked tools once there are any", () => {
    setup("notion-search");

    expect(screen.getByText(/1 of 3 ticked/)).toBeTruthy();
    expect(screen.getByText(/1 carried per turn, roughly 350 tokens/)).toBeTruthy();
  });

  // The control: without a catalogue the text field is the only way in, and it must still work.
  it("falls back to the text field when the server was never tested", () => {
    const onChange = setup("a, b", null);

    const field = screen.getByLabelText("Tool allowlist for notion") as HTMLInputElement;
    expect(field.value).toBe("a, b");
    fireEvent.change(field, { target: { value: "a, b, c" } });
    expect(onChange).toHaveBeenCalledWith("a, b, c");
    expect(screen.queryByText(/carried per turn/)).toBeNull();
  });
});

describe("parseAllowlist", () => {
  it("ignores blanks and stray whitespace the field invites", () => {
    expect(parseAllowlist(" a ,, b , ")).toEqual(["a", "b"]);
    expect(parseAllowlist("")).toEqual([]);
  });
});

/**
 * A server without `allowWrites` drops its mutating tools at discovery. The picker used to offer
 * them anyway, so an admin could tick three, see "(3)" everywhere and have the turn carry none —
 * the operator sees it ticked and the agent denies it (BP-569 review).
 */
describe("a server that may not write", () => {
  it("will not let a mutating tool be ticked, and says why", () => {
    setup("", CATALOG, false);

    const write = screen.getByLabelText("notion-update-page for notion");
    expect(write.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("needs Allow writes")).toBeTruthy();
  });

  it("counts only what the turn will carry", () => {
    setup("", CATALOG, false);

    expect(screen.getByText(/2 carried per turn/)).toBeTruthy();
  });

  // The control: with writes allowed the same tool is tickable and counted
  it("leaves it tickable when writes are allowed", () => {
    setup("", CATALOG, true);

    expect(screen.getByLabelText("notion-update-page for notion").getAttribute("aria-disabled")).toBe("false");
    expect(screen.getByText(/3 carried per turn/)).toBeTruthy();
  });
});

describe("carriedTools", () => {
  it("reads an empty allowlist as every reachable tool", () => {
    expect(carriedTools(CATALOG, "", true)).toHaveLength(3);
    expect(carriedTools(CATALOG, "", false)).toEqual(["notion-search", "notion-fetch"]);
  });

  it("ignores a ticked name the server does not offer", () => {
    expect(carriedTools(CATALOG, "notion-search, gone-away", true)).toEqual(["notion-search"]);
  });

  it("trusts a hand-typed name when there is no catalogue to check it against", () => {
    expect(carriedTools(undefined, "typed-by-hand", true)).toEqual(["typed-by-hand"]);
  });
});

describe("the same tool offered twice", () => {
  it("appears once, so ticking one does not flip the other", () => {
    const twice = [...CATALOG, { name: "notion-search", description: "again", readSafe: true }];
    const onChange = vi.fn();
    render(
      <McpToolPicker
        rowName="notion"
        catalog={twice}
        allowlist=""
        allowWrites
        onChange={onChange}
      />
    );

    expect(screen.getAllByLabelText("notion-search for notion")).toHaveLength(1);
  });
});

describe("the cap the validator enforces", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    name: `list_thing_${i}`,
    description: `Thing ${i}`,
    readSafe: true,
  }));

  it("stops at 50 rather than letting the whole save be refused", () => {
    const fifty = many.slice(0, 50).map((t) => t.name).join(", ");
    render(
      <McpToolPicker rowName="wide" catalog={many} allowlist={fifty} allowWrites onChange={vi.fn()} />
    );

    expect(screen.getByText(/50 tools is the most one server can list/)).toBeTruthy();
    expect(screen.getByLabelText("list_thing_55 for wide").getAttribute("aria-disabled")).toBe("true");
    // An already-ticked one stays tickable, or there would be no way back under the cap
    expect(screen.getByLabelText("list_thing_1 for wide").getAttribute("aria-disabled")).toBe("false");
  });
});

/**
 * The checkbox cap cannot see a list that was pasted, and `validatePmConfig` refuses the WHOLE PM
 * save rather than this one field — so an admin pasting sixty names loses every unrelated edit on
 * the screen to a toast that does not name the cause (BP-569 review 2).
 */
describe("a hand-typed list over the cap", () => {
  const sixty = Array.from({ length: 60 }, (_, i) => `list_thing_${i}`).join(", ");

  it("says so before Save is pressed", () => {
    setup(sixty, null);

    expect(screen.getByText(/60 tools listed/)).toBeTruthy();
    expect(screen.getByText(/50 is the most one server can have/)).toBeTruthy();
  });

  // The control: a list within the cap says nothing
  it("stays quiet at the cap itself", () => {
    setup(Array.from({ length: 50 }, (_, i) => `list_thing_${i}`).join(", "), null);

    expect(screen.queryByText(/tools listed/)).toBeNull();
  });
});

/**
 * `discoverMcpTools` keeps a name offered twice as two tools under a `_2` suffix, so counting the
 * de-duplicated render list under-reports what the turn actually carries (BP-569 review 2).
 */
describe("a duplicated name", () => {
  const twice = [...CATALOG, { name: "notion-search", description: "again", readSafe: true }];

  it("is rendered once but counted twice, because the turn carries it twice", () => {
    render(
      <McpToolPicker rowName="notion" catalog={twice} allowlist="" allowWrites onChange={vi.fn()} />
    );

    expect(screen.getAllByLabelText("notion-search for notion")).toHaveLength(1);
    expect(screen.getByText(/4 carried per turn/)).toBeTruthy();
  });
});

/**
 * The counter has to agree with `discoverMcpTools` in the state the picker leaves behind — with
 * an allowlist present. Counting the ticked NAMES collapsed a duplicate the runtime admits twice,
 * and that is the normal state, not the empty-allowlist one (BP-569 review 3).
 */
describe("a duplicated name that is ticked", () => {
  const twice = [...CATALOG, { name: "notion-search", description: "again", readSafe: true }];

  it("counts both catalogue entries, not the one name", () => {
    render(
      <McpToolPicker
        rowName="notion"
        catalog={twice}
        allowlist="notion-search"
        allowWrites
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText(/2 carried per turn/)).toBeTruthy();
  });

  it("still counts a singly-offered ticked tool once", () => {
    render(
      <McpToolPicker
        rowName="notion"
        catalog={twice}
        allowlist="notion-fetch"
        allowWrites
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText(/1 carried per turn/)).toBeTruthy();
  });
});

describe("the cap warning and the request body", () => {
  it("does not cry wolf over a duplicate the save will collapse", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `list_thing_${i}`);
    setup([...fifty, "list_thing_0"].join(", "), null);

    expect(screen.queryByText(/tools listed/)).toBeNull();
  });

  it("still warns on 51 distinct names", () => {
    setup(Array.from({ length: 51 }, (_, i) => `list_thing_${i}`).join(", "), null);

    expect(screen.getByText(/51 tools listed/)).toBeTruthy();
  });
});

/**
 * `aria-disabled` announces; it does not enforce. Without a guard in `toggle` a keyboard user
 * reaches the checkbox — which is the point of using it over `disabled` — and ticks a tool the
 * turn will drop (BP-569 review 3).
 */
describe("a tool the turn would drop", () => {
  it("refuses the tick even though the checkbox is reachable", () => {
    const onChange = setup("", CATALOG, false);

    fireEvent.click(screen.getByLabelText("notion-update-page for notion"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("can still be unticked when it is already in the list", () => {
    const onChange = setup("notion-update-page", CATALOG, false);

    fireEvent.click(screen.getByLabelText("notion-update-page for notion"));

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("describes itself beyond its name, so the badge is not silent", () => {
    setup("", CATALOG, false);

    const box = screen.getByLabelText("notion-update-page for notion");
    const described = document.getElementById(box.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toContain("writes");
    expect(described?.textContent).toContain("needs Allow writes");
  });
});

describe("Use all tools", () => {
  it("is offered only when something is ticked, and clears the list", () => {
    const onChange = setup("notion-search", CATALOG);

    fireEvent.click(screen.getByLabelText("Use every tool from notion"));

    expect(onChange).toHaveBeenCalledWith("");
  });

  it("is absent when the list is already empty, where it would do nothing", () => {
    setup("", CATALOG);

    expect(screen.queryByLabelText("Use every tool from notion")).toBeNull();
  });
});

describe("the filter", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({
    name: `list_thing_${i}`,
    description: i === 3 ? "the needle" : `Thing ${i}`,
    readSafe: true,
  }));

  it("matches a description, not only a name", () => {
    render(
      <McpToolPicker rowName="wide" catalog={many} allowlist="" allowWrites onChange={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText("Filter tools for wide"), {
      target: { value: "needle" },
    });

    expect(screen.getByLabelText("list_thing_3 for wide")).toBeTruthy();
    expect(screen.queryByLabelText("list_thing_4 for wide")).toBeNull();
  });

  it("says so when nothing matches, rather than showing an empty box", () => {
    render(
      <McpToolPicker rowName="wide" catalog={many} allowlist="" allowWrites onChange={vi.fn()} />
    );

    fireEvent.change(screen.getByLabelText("Filter tools for wide"), {
      target: { value: "zzz" },
    });

    expect(screen.getByText("No tool matches that filter.")).toBeTruthy();
  });

  // The control: a short catalogue needs no filter, and offering one is clutter
  it("is not offered for a catalogue of three", () => {
    setup("", CATALOG);

    expect(screen.queryByLabelText("Filter tools for notion")).toBeNull();
  });
});

describe("a ticked tool the server does not offer", () => {
  it("does not inflate the ticked count past the catalogue size", () => {
    setup("nope-1, nope-2, nope-3, nope-4, nope-5", CATALOG);

    expect(screen.getByText(/0 of 3 ticked/)).toBeTruthy();
    expect(screen.getByText(/0 carried per turn/)).toBeTruthy();
  });
});
