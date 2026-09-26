// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SettingsProvider, useDirtyGroup } from "./settings-context";

afterEach(cleanup);

function Group({ saveLast }: { saveLast?: boolean }) {
  useDirtyGroup(
    { id: "g", section: "s", label: "S · G", count: 1, saveLast },
    { save: async () => {}, discard: () => {} }
  );
  return null;
}

// saveAllGroups orders by it, so a group that asks to go last must reach the registry saying so
describe("useDirtyGroup", () => {
  it("registers a group's wish to be saved last", () => {
    const register = vi.fn();
    render(
      <SettingsProvider register={register} unregister={vi.fn()}>
        <Group saveLast />
      </SettingsProvider>
    );

    expect(register).toHaveBeenLastCalledWith(expect.objectContaining({ id: "g", saveLast: true }));
  });
});
