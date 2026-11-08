import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

const platformSend = vi.fn();
const ownSend = vi.fn();
const ownMailServerFor = vi.fn();
const ownMailTransport = vi.fn(async () => ({ sendMail: ownSend }));

vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: platformSend }) } }));
vi.mock("./organisation-smtp", () => ({
  ownMailServerFor,
  ownMailTransport,
  ownMailFrom: (server: { fromAddress: string }) => server.fromAddress,
}));

vi.stubEnv("SMTP_HOST", "smtp.platform.example");
vi.stubEnv("SMTP_USER", "platform");
vi.stubEnv("SMTP_PASS", "platform-pass");
vi.stubEnv("SMTP_FROM", "Board Planner <noreply@platform.example>");

const { sendEmail, sendEmailOrThrow } = await import("./email");

const ORGANISATION = new Types.ObjectId();
const OWN = { host: "smtp.acme.example", port: 587, user: "mailer", password: "p", fromAddress: "boards@acme.example", fromName: "" };
const MESSAGE = { to: "ada@acme.example", subject: "s", text: "t" };

beforeEach(() => {
  vi.clearAllMocks();
  platformSend.mockResolvedValue(undefined);
  ownSend.mockResolvedValue(undefined);
  ownMailServerFor.mockResolvedValue(null);
});

describe("which server a message leaves through (BP-899)", () => {
  it("an organisation's mail goes through its own server, from its own address", async () => {
    ownMailServerFor.mockResolvedValue(OWN);

    await expect(sendEmail({ ...MESSAGE, sender: ORGANISATION })).resolves.toBe(true);

    expect(ownMailServerFor).toHaveBeenCalledWith(ORGANISATION);
    expect(ownMailTransport).toHaveBeenCalledWith(OWN);
    expect(ownSend).toHaveBeenCalledWith(expect.objectContaining({ to: MESSAGE.to, from: "boards@acme.example" }));
    expect(platformSend).not.toHaveBeenCalled();
  });

  it("an organisation with none of its own uses the platform's", async () => {
    await expect(sendEmail({ ...MESSAGE, sender: ORGANISATION })).resolves.toBe(true);

    expect(platformSend).toHaveBeenCalledWith(expect.objectContaining({ to: MESSAGE.to, from: "Board Planner <noreply@platform.example>" }));
    expect(ownSend).not.toHaveBeenCalled();
  });

  it("a refusal by the organisation's own server is a failure, never a send through the platform's", async () => {
    ownMailServerFor.mockResolvedValue(OWN);
    ownSend.mockRejectedValue(new Error("550 relay denied"));

    await expect(sendEmailOrThrow({ ...MESSAGE, sender: ORGANISATION })).rejects.toThrow("550 relay denied");
    await expect(sendEmail({ ...MESSAGE, sender: ORGANISATION })).resolves.toBe(false);
    expect(platformSend).not.toHaveBeenCalled();
  });

  it("the platform's own mail never asks about an organisation's server", async () => {
    await expect(sendEmail({ ...MESSAGE, sender: "platform" })).resolves.toBe(true);

    expect(ownMailServerFor).not.toHaveBeenCalled();
    expect(platformSend).toHaveBeenCalledTimes(1);
  });
});
