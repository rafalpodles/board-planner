import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket, createSecureContext } from "node:tls";
import { fatal, fatalOnListenFailure, keepAlive, serve } from "./stub-guard.mjs";

/**
 * A mail server on this machine that records every message it is handed.
 *
 * Its own process for the same reason as the webhook receiver: `sendEmailNotifications` is
 * fire-and-forget, so the message is handed over after the route has answered and after the test's
 * own request has resolved.
 *
 * Two ports. The SMTP one is what `nodemailer` talks to; the HTTP one is what a spec reads —
 * `GET /messages` returns what has arrived, `POST /reset` clears it.
 *
 * STARTTLS is not optional here. `src/lib/email.ts` sets `requireTLS` on every port but 465
 * (BP-306, so a stripped advertisement cannot get the AUTH exchange in cleartext), and nodemailer
 * refuses a server that does not offer the upgrade. So this stub offers it, with a throwaway
 * certificate `openssl` makes at startup — and the dev server the suite boots carries
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` for it, which is why that variable is set there and nowhere
 * else.
 */

const NAME = "smtp stub";
const LOOPBACK = "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_STUB_PORT ?? 3993);
const CONTROL_PORT = Number(process.env.SMTP_STUB_CONTROL_PORT ?? SMTP_PORT + 1);

/** `{ from, to, data }` per message, oldest first. */
let messages = [];

function selfSignedCertificate() {
  const dir = mkdtempSync(join(tmpdir(), "bp-smtp-stub-"));
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      // prettier-ignore
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", cert, "-days", "1",
        "-subj", "/CN=localhost",
      ],
      { stdio: "ignore" }
    );
  } catch (error) {
    fatal(NAME, `openssl could not make a certificate: ${error}`);
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

const context = createSecureContext(selfSignedCertificate());

/**
 * One connection's conversation, over whichever socket it is currently on — the same state machine
 * runs again on the TLS socket after an upgrade, which is what the protocol asks for.
 */
function converse(socket, session) {
  let buffer = "";

  socket.setEncoding("utf8");
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk) => {
    buffer += chunk;

    if (session.readingData) {
      // The terminator can straddle two chunks, so it is looked for in the whole buffer
      const end = buffer.indexOf("\r\n.\r\n");
      if (end === -1) return;
      session.data += buffer.slice(0, end);
      buffer = buffer.slice(end + 5);
      session.readingData = false;
      messages.push({ from: session.from, to: session.to, data: session.data });
      session.data = "";
      session.to = [];
      socket.write("250 2.0.0 Ok: queued\r\n");
    }

    let newline;
    while (!session.readingData && (newline = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 2);
      command(socket, session, line);
    }
  });
}

function command(socket, session, line) {
  const verb = line.split(" ")[0].toUpperCase();

  // A continuation of AUTH LOGIN — the client's base64 username, then its password. Neither is
  // checked: what a spec asserts is that a message arrived, never who sent it.
  if (session.expectingAuth) {
    session.expectingAuth = session.expectingAuth === "username" ? "password" : null;
    socket.write(session.expectingAuth ? "334 UGFzc3dvcmQ6\r\n" : "235 2.7.0 Accepted\r\n");
    return;
  }

  switch (verb) {
    case "EHLO":
    case "HELO":
      socket.write(
        session.secure
          ? `250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n`
          : `250-localhost\r\n250-STARTTLS\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n`
      );
      return;
    case "STARTTLS": {
      socket.write("220 2.0.0 Ready to start TLS\r\n");
      socket.removeAllListeners("data");
      const secured = new TLSSocket(socket, { isServer: true, secureContext: context });
      converse(secured, { ...session, secure: true, to: [], data: "" });
      return;
    }
    case "AUTH":
      // `AUTH PLAIN <credentials>` carries them inline and needs no prompt; `AUTH LOGIN` prompts.
      if (/^AUTH\s+LOGIN\s*$/i.test(line)) {
        session.expectingAuth = "username";
        socket.write("334 VXNlcm5hbWU6\r\n");
        return;
      }
      socket.write("235 2.7.0 Accepted\r\n");
      return;
    case "MAIL":
      session.from = address(line);
      session.to = [];
      socket.write("250 2.1.0 Ok\r\n");
      return;
    case "RCPT":
      session.to.push(address(line));
      socket.write("250 2.1.5 Ok\r\n");
      return;
    case "DATA":
      session.readingData = true;
      session.data = "";
      socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
      return;
    case "RSET":
      session.to = [];
      session.data = "";
      socket.write("250 2.0.0 Ok\r\n");
      return;
    case "QUIT":
      socket.write("221 2.0.0 Bye\r\n");
      socket.end();
      return;
    default:
      socket.write("250 2.0.0 Ok\r\n");
  }
}

function address(line) {
  return /<([^>]*)>/.exec(line)?.[1] ?? "";
}

keepAlive(NAME);

const smtp = fatalOnListenFailure(
  NAME,
  createTcpServer((socket) => {
    socket.write("220 localhost ESMTP stub\r\n");
    converse(socket, { secure: false, from: "", to: [], data: "", readingData: false });
  })
);
smtp.listen(SMTP_PORT, LOOPBACK, () => console.log(`${NAME} listening on ${SMTP_PORT}`));

serve({
  name: `${NAME} control`,
  port: CONTROL_PORT,
  host: LOOPBACK,
  handler: async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    if (req.url === "/reset") {
      messages = [];
    }
    const payload = JSON.stringify(req.url === "/reset" ? { ok: true } : messages);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  },
});
