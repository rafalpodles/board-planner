/**
 * Prints a new licence signing keypair.
 *
 * Usage: npx tsx scripts/generate-licence-keypair.ts <keyId>
 *
 * The first line is the private key, the value LICENCE_SIGNING_KEY takes: keep it in the licence
 * service and a password manager, never in this repository. The second is the entry to add to
 * LICENCE_PUBLIC_KEYS in src/lib/licence-keys.ts.
 */

import { generateKeyPairSync } from "node:crypto";

const keyId = process.argv[2];
if (!keyId || !/^[a-z0-9-]+$/.test(keyId)) {
  console.error("Usage: generate-licence-keypair.ts <keyId>   (lowercase letters, digits and dashes)");
  process.exit(1);
}

const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
console.log(JSON.stringify({ keyId, d: jwk.d, x: jwk.x }));
console.log(`{ keyId: "${keyId}", x: "${jwk.x}" },`);
