import { describe, it, expect } from "vitest";
import type { IUser } from "@/types";
import {
  actingThrough,
  currentProvenance,
  provenanceOfRequest,
  shownSource,
  MCP_CLIENT_HEADER,
  SOURCE_DETAIL_MAX_LENGTH,
} from "./activity-source";
import { writtenBy, pmAgentMark } from "./ai-generated";

const person = (over: Partial<IUser> = {}) => ({ viaMachineCredential: false, ...over }) as IUser;
const request = (headers: Record<string, string> = {}) => new Request("http://localhost/api/x", { headers });

describe("provenanceOfRequest", () => {
  it("reads a browser session as the web app, whatever header it sends", () => {
    expect(provenanceOfRequest(request({ [MCP_CLIENT_HEADER]: "mcp" }), person())).toEqual({ source: "web-ui" });
  });

  it("reads a token as the API, naming the OAuth application it was issued to", () => {
    expect(provenanceOfRequest(request(), person({ viaMachineCredential: true }))).toEqual({ source: "api" });
    expect(
      provenanceOfRequest(request(), person({ viaMachineCredential: true, oauthClientName: "Zapier" }))
    ).toEqual({ source: "api", detail: "Zapier" });
  });

  it("reads a token that came through the MCP server as MCP", () => {
    expect(
      provenanceOfRequest(request({ [MCP_CLIENT_HEADER]: "mcp" }), person({ viaMachineCredential: true, oauthClientName: "Notion" }))
    ).toEqual({ source: "mcp", detail: "Notion" });
  });
});

describe("currentProvenance", () => {
  it("is the system when nobody set one", () => {
    expect(currentProvenance()).toEqual({ source: "system" });
  });

  it("is what the request acted through, with its detail clipped", () => {
    const long = "n".repeat(SOURCE_DETAIL_MAX_LENGTH + 50);
    expect(actingThrough({ source: "worker", detail: long }, currentProvenance)).toEqual({
      source: "worker",
      detail: "n".repeat(SOURCE_DETAIL_MAX_LENGTH),
    });
    expect(actingThrough({ source: "api", detail: "  " }, currentProvenance)).toEqual({ source: "api" });
  });

  it("is the PM agent inside a PM turn, whichever request it runs in", () => {
    expect(actingThrough({ source: "web-ui" }, () => writtenBy(pmAgentMark("m1"), currentProvenance))).toEqual({
      source: "pm-agent",
      detail: "m1",
    });
  });
});

describe("shownSource", () => {
  it("reads a row written before sources were kept as legacy", () => {
    expect(shownSource(undefined)).toBe("legacy");
    expect(shownSource("nonsense")).toBe("legacy");
    expect(shownSource("mcp")).toBe("mcp");
  });
});
