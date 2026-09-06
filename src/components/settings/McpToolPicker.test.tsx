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

  it("counts an empty allowlist as the whole catalogue, not as nothing", () => {
    setup("");

    expect(screen.getByText(/Nothing ticked, so every tool this server offers is used/)).toBeTruthy();
    expect(screen.getByText(/3 carried per turn, roughly 1050 tokens/)).toBeTruthy();
  });

  it("counts the ticked tools once there are any", () => {
    setup("notion-search");

    expect(screen.getByText(/1 of 3 ticked/)).toBeTruthy();
    expect(screen.getByText(/1 carried per turn, roughly 350 tokens/)).toBeTruthy();
  });

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
    expect(screen.getByLabelText("list_thing_1 for wide").getAttribute("aria-disabled")).toBe("false");
  });
});

describe("a hand-typed list over the cap", () => {
  const sixty = Array.from({ length: 60 }, (_, i) => `list_thing_${i}`).join(", ");

  it("says so before Save is pressed", () => {
    setup(sixty, null);

    expect(screen.getByText(/60 tools listed/)).toBeTruthy();
    expect(screen.getByText(/50 is the most one server can have/)).toBeTruthy();
  });

  it("stays quiet at the cap itself", () => {
    setup(Array.from({ length: 50 }, (_, i) => `list_thing_${i}`).join(", "), null);

    expect(screen.queryByText(/tools listed/)).toBeNull();
  });
});

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

describe("at the cap", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({
    name: `list_thing_${i}`,
    description: `Thing ${i}`,
    readSafe: true,
  }));
  const fifty = many.slice(0, 50).map((t) => t.name).join(", ");

  function atCap(allowlist = fifty) {
    const onChange = vi.fn();
    render(
      <McpToolPicker
        rowName="wide"
        catalog={many}
        allowlist={allowlist}
        allowWrites
        onChange={onChange}
      />
    );
    return onChange;
  }

  it("refuses a fifty-first tick rather than letting the save be rejected", () => {
    const onChange = atCap();

    fireEvent.click(screen.getByLabelText("list_thing_55 for wide"));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("still allows unticking", () => {
    const onChange = atCap();

    fireEvent.click(screen.getByLabelText("list_thing_0 for wide"));

    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0]).not.toContain("list_thing_0,");
  });

  it("says why on the tool itself, not only above a list that scrolls", () => {
    atCap();

    const box = screen.getByLabelText("list_thing_55 for wide");
    const described = document.getElementById(box.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toContain("50-tool limit");
  });
});

describe("the tool name a sighted reader sees", () => {
  it("is rendered, not only used as the accessible name", () => {
    setup("", CATALOG);

    expect(screen.getByText("notion-search", { selector: "code" })).toBeTruthy();
  });
});

describe("two pickers on one screen", () => {
  it("do not share description ids, even for the same tool name", () => {
    render(
      <McpToolPicker rowName="one" catalog={CATALOG} allowlist="" allowWrites onChange={vi.fn()} />
    );
    render(
      <McpToolPicker rowName="two" catalog={CATALOG} allowlist="" allowWrites onChange={vi.fn()} />
    );

    const first = screen.getByLabelText("notion-search for one").getAttribute("aria-describedby");
    const second = screen.getByLabelText("notion-search for two").getAttribute("aria-describedby");

    expect(first).not.toBe(second);
    expect(document.querySelectorAll(`[id="${first}"]`)).toHaveLength(1);
  });
});
