// Loaded into the app server under test only (BP-802). Every Playwright request context shares one
// keep-alive agent, and a socket Node's server closes for idleness just as that agent reuses it
// fails the request with ECONNRESET. `next dev` has no --keepAliveTimeout to lengthen it.
const http = require("node:http");

const createServer = http.createServer;
http.createServer = function createServerKeepingIdleConnections(...args) {
  const server = createServer.apply(this, args);
  server.keepAliveTimeout = 0;
  return server;
};
