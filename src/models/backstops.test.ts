import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import { Task } from "./task";
import { Comment } from "./comment";
import { Project } from "./project";
import { Worker } from "./worker";

const id = () => new mongoose.Types.ObjectId();
const errorsOf = (doc: mongoose.Document) => Object.keys(doc.validateSync()?.errors ?? {});

// BP-323: the routes hold the product's caps; these hold a writer that forgets one to a bound
describe("schema backstops", () => {
  it("bounds a task's title, description, criteria text and criteria count", () => {
    const ok = new Task({ project: id(), createdBy: id(), taskNumber: 1, title: "t", description: "d", checklist: [{ text: "c" }] });
    expect(errorsOf(ok)).toEqual([]);

    const over = new Task({
      project: id(),
      createdBy: id(),
      taskNumber: 1,
      title: "t".repeat(2_001),
      description: "d".repeat(500_001),
      checklist: [{ text: "c".repeat(5_001) }],
    });
    expect(errorsOf(over)).toEqual(expect.arrayContaining(["title", "description", "checklist.0.text"]));

    const many = new Task({ project: id(), createdBy: id(), taskNumber: 1, title: "t", checklist: Array.from({ length: 2_001 }, () => ({ text: "c" })) });
    expect(errorsOf(many)).toContain("checklist");
  });

  it("bounds a comment's body", () => {
    expect(errorsOf(new Comment({ task: id(), author: id(), body: "b".repeat(100_000) }))).toEqual([]);
    expect(errorsOf(new Comment({ task: id(), author: id(), body: "b".repeat(100_001) }))).toContain("body");
  });

  it("bounds a webhook URL and a chat channel's name and stored URL", () => {
    const project = new Project({
      name: "p",
      key: "P",
      owner: id(),
      webhooks: [{ url: `https://x.example/${"a".repeat(2_048)}` }],
      notificationChannels: [{ type: "slack", name: "n".repeat(101), webhookUrl: "u".repeat(12_001) }],
    });
    expect(errorsOf(project)).toEqual(
      expect.arrayContaining(["webhooks.0.url", "notificationChannels.0.name", "notificationChannels.0.webhookUrl"])
    );
  });

  it("bounds what a worker stores about itself", () => {
    const worker = new Worker({
      name: "w",
      protocolVersion: 1,
      credentialHash: "h",
      version: "v".repeat(201),
      bindingError: "e".repeat(5_001),
      repos: [{ remote: "r".repeat(2_001), path: "/p" }],
    });
    expect(errorsOf(worker)).toEqual(expect.arrayContaining(["version", "bindingError", "repos.0.remote"]));

    const many = new Worker({
      name: "w",
      protocolVersion: 1,
      credentialHash: "h",
      repos: Array.from({ length: 1_001 }, () => ({ remote: "r", path: "/p" })),
    });
    expect(errorsOf(many)).toContain("repos");
  });
});
