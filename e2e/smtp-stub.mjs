import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TLSSocket, createSecureContext } from "node:tls";
import { unstuff } from "./dot-stuffing.mjs";
import { fatal, fatalOnListenFailure, keepAlive, serve } from "./stub-guard.mjs";

/**
 * A mail server on this machine that records every message it is handed.
 *
 * Its own process for the same reason as the webhook receiver: `sendEmailNotifications` is
 * fire-and-forget, so the message is handed over after the route has answered and after the test's
 * own request has resolved.
 *
 * Two ports. The SMTP one is what `nodemailer` talks to; the HTTP one is what a spec reads and
 * steers: `/reset` clears what has arrived and cancels any refusal, `/refuse?to=<address>` makes
 * the server answer 550 to mail for that one recipient (and `/refuse` with no address stops), and
 * any other path returns what has arrived. Routed on the path; the method is not checked, which is
 * the same looseness every other stub's control port here has.
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
const SMTP_PORT = Number(process.env.SMTP_STUB_PORT ?? 3994);
const CONTROL_PORT = Number(process.env.SMTP_STUB_CONTROL_PORT ?? SMTP_PORT + 1);

/** `{ from, to, data }` per message, oldest first. */
let messages = [];

/**
 * An address the server refuses to accept mail for, or `null`.
 *
 * Named rather than a "refuse the next one" flag, because the run's other mail is fire-and-forget:
 * a message dispatched by an earlier spec can still be on its way, and an unscoped refusal would
 * land on whichever arrived first. An address one spec owns cannot be hit by anybody else's.
 */
let refuseFor = null;

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
  const material = { key: readFileSync(key), cert: readFileSync(cert) };
  // Deleted now rather than on exit: Playwright stops a webServer with a signal, and Node's default
  // signal handling runs no `exit` handler — so the ordinary end of a run would leave the directory
  // and its private key behind, which is the path that happens every time. Nothing reads the files
  // again once they are in memory.
  rmSync(dir, { recursive: true, force: true });
  return material;
}

const context = createSecureContext(selfSignedCertificate());

/**
 * One connection's conversation, over whichever socket it is currently on — the same state machine
 * runs again on the TLS socket after an upgrade, which is what the protocol asks for.
 *
 * Buffers rather than `setEncoding("utf8")`: the raw socket is handed to a `TLSSocket` on STARTTLS,
 * and leaving a string decoder on a socket whose remaining bytes are a TLS stream is wrong on its
 * face. Measured, not assumed to matter: 150 messages through each version, none lost either way.
 * This one is kept because it is also what makes the loop below correct for a client that sends
 * DATA and its body in one packet.
 */
function converse(socket, session) {
  let buffer = Buffer.alloc(0);

  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    // One loop for both states: a client is allowed to send DATA and its body in a single packet,
    // and handling the body only on the *next* chunk would leave the message sitting in the buffer.
    for (;;) {
      if (session.readingData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end === -1) return;
        session.data += unstuff(buffer.subarray(0, end).toString("utf8"));
        buffer = buffer.subarray(end + 5);
        session.readingData = false;
        const refused = refuseFor !== null && session.to.includes(refuseFor);
        if (!refused) messages.push({ from: session.from, to: session.to, data: session.data });
        session.data = "";
        session.to = [];
        // After the body, not at RCPT: what the mail screen exists to show is the sentence a server
        // says when it has read a message and will not take it, which is this one.
        socket.write(
          refused
            ? "550 5.7.1 Rejected on request of the test\r\n"
            : "250 2.0.0 Ok: queued\r\n"
        );
        continue;
      }

      const newline = buffer.indexOf("\r\n");
      if (newline === -1) return;
      const line = buffer.subarray(0, newline).toString("utf8");
      buffer = buffer.subarray(newline + 2);
      // Anything the client pipelined behind STARTTLS belongs to the TLS handshake, not to this
      // socket's conversation — `command` hands the connection over and this one is finished.
      if (command(socket, session, line) === "upgraded") return;
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
      // Upgraded inside the write callback, not alongside it: `TLSSocket` takes the handle
      // immediately, so constructing it next to the write races the greeting out of a socket TLS
      // has already claimed. On loopback those 30 bytes go out synchronously every time, which is
      // what would make the failure a rare handshake into nowhere rather than an obvious one.
      //
      // `from` is discarded with the rest: RFC 3207 §4.2 has the server forget the session state
      // on upgrade, and the client repeats EHLO and MAIL over the new socket.
      socket.removeAllListeners("data");
      // Paused, not merely unlistened: removing the handler leaves the socket flowing with nobody
      // reading, and anything arriving before `TLSSocket` takes over is dropped rather than
      // buffered — measured at `readableLength` 0 with `read()` returning null, against 19 bytes
      // retained when paused. `TLSSocket`'s constructor feeds whatever is buffered into the
      // handshake, so pausing is what gives it something to find.
      socket.pause();
      socket.write("220 2.0.0 Ready to start TLS\r\n", () => {
        const secured = new TLSSocket(socket, { isServer: true, secureContext: context });
        converse(secured, { ...session, secure: true, from: "", to: [], data: "", readingData: false });
      });
      return "upgraded";
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
      // The whole transaction, not half of it. Unreachable through nodemailer without a pool, but
      // a reset that left `readingData` set would strand the next command in data mode.
      session.from = "";
      session.to = [];
      session.data = "";
      session.readingData = false;
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
    // Parsed rather than compared whole, because `/refuse` carries the address in its query. The
    // other paths gain nothing from it and lose the looseness they had, which nothing relied on.
    const { pathname, searchParams } = new URL(req.url ?? "/", "http://localhost");

    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    if (pathname === "/reset") {
      messages = [];
      // A spec that fails between refusing and accepting again must not leave the next one with a
      // server that quietly drops its mail
      refuseFor = null;
    }
    // `/refuse?to=a@b` starts refusing that recipient; `/refuse` with no address stops.
    if (pathname === "/refuse") {
      refuseFor = searchParams.get("to");
    }
    const acknowledged = pathname === "/reset" || pathname === "/refuse";
    const payload = JSON.stringify(acknowledged ? { ok: true, refuseFor } : messages);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  },
});
