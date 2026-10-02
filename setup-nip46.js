import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  generateSecretKey,
  getPublicKey,
  nip19,
} from "nostr-tools";

import {
  BunkerSigner,
  createNostrConnectURI,
} from "nostr-tools/nip46";

import {
  SimplePool,
} from "nostr-tools/pool";

const NOSTR_NPUB = process.env.NOSTR_NPUB;

const SECRETS_DIR = path.resolve(".secrets");

const CLIENT_KEY_FILE = path.join(
  SECRETS_DIR,
  "nip46-client.key"
);

const SESSION_FILE = path.join(
  SECRETS_DIR,
  "nip46-session.json"
);

const NIP46_RELAYS = (
  process.env.NIP46_RELAYS ||
  [
    "wss://relay.primal.net",
    "wss://relay.damus.io",
  ].join(",")
)
  .split(",")
  .map((relay) => relay.trim())
  .filter(Boolean);

const REQUIRED_PERMISSIONS = [
  "sign_event:1",
  "sign_event:22242",
  "sign_event:24242",
];

async function ensureSecretsDir() {
  await fs.mkdir(SECRETS_DIR, {
    recursive: true,
    mode: 0o700,
  });

  try {
    await fs.chmod(SECRETS_DIR, 0o700);
  } catch {}
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function saveClientKey(secretKey) {
  const hex = Buffer.from(secretKey).toString("hex");

  await fs.writeFile(
    CLIENT_KEY_FILE,
    `${hex}\n`,
    {
      mode: 0o600,
    }
  );

  try {
    await fs.chmod(CLIENT_KEY_FILE, 0o600);
  } catch {}
}

async function loadClientKey() {
  if (!(await fileExists(CLIENT_KEY_FILE))) {
    return null;
  }

  const hex = (
    await fs.readFile(CLIENT_KEY_FILE, "utf8")
  ).trim();

  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("Invalid NIP-46 client key.");
  }

  return new Uint8Array(Buffer.from(hex, "hex"));
}

async function loadSession() {
  if (!(await fileExists(SESSION_FILE))) {
    return null;
  }

  return JSON.parse(
    await fs.readFile(SESSION_FILE, "utf8")
  );
}

async function saveSession(signer, userPubkey) {
  const session = {
    userPubkey,
    permissions: REQUIRED_PERMISSIONS,
    configuredAt: new Date().toISOString(),
    bunkerPointer: {
      pubkey: signer.bp.pubkey,
      relays: signer.bp.relays,
      secret: null,
    },
  };

  await fs.writeFile(
    SESSION_FILE,
    JSON.stringify(session, null, 2),
    {
      mode: 0o600,
    }
  );

  try {
    await fs.chmod(SESSION_FILE, 0o600);
  } catch {}
}

function sessionHasRequiredPermissions(session) {
  const granted = new Set(
    Array.isArray(session?.permissions)
      ? session.permissions
      : []
  );

  return REQUIRED_PERMISSIONS.every(
    (permission) => granted.has(permission)
  );
}

function getExpectedPubkey() {
  if (!NOSTR_NPUB) {
    throw new Error("NOSTR_NPUB missing from .env");
  }

  const decoded = nip19.decode(NOSTR_NPUB);

  if (decoded.type !== "npub") {
    throw new Error("NOSTR_NPUB is not a valid npub.");
  }

  return decoded.data;
}

async function verifyExistingSession(
  clientSecretKey,
  session,
  expectedPubkey
) {
  const pool = new SimplePool();

  const signer = BunkerSigner.fromBunker(
    clientSecretKey,
    session.bunkerPointer,
    {
      pool,
      onauth(url) {
        console.log("");
        console.log("Signer authentication required:");
        console.log(url);
        console.log("");
      },
    }
  );

  try {
    const pubkey = await signer.getPublicKey();

    if (pubkey !== expectedPubkey) {
      throw new Error(
        "Existing NIP-46 session is connected to the wrong Nostr account."
      );
    }

    return true;
  } finally {
    try {
      await signer.close();
    } catch {}

    try {
      pool.close(session.bunkerPointer?.relays || []);
    } catch {}
  }
}

async function main() {
  await ensureSecretsDir();

  const expectedPubkey = getExpectedPubkey();

  let clientSecretKey = await loadClientKey();
  const existingSession = await loadSession();

  if (
    clientSecretKey &&
    existingSession &&
    sessionHasRequiredPermissions(existingSession)
  ) {
    await verifyExistingSession(
      clientSecretKey,
      existingSession,
      expectedPubkey
    );

    console.log("NIP-46 session is valid.");
    console.log(
      `Permissions: ${REQUIRED_PERMISSIONS.join(", ")}`
    );
    return;
  }

  if (!clientSecretKey) {
    clientSecretKey = generateSecretKey();
    await saveClientKey(clientSecretKey);
  }

  if (existingSession) {
    console.log(
      "Existing NIP-46 session needs updated permissions."
    );
    console.log(
      "A replacement authorization will be created."
    );
  }

  const clientPubkey = getPublicKey(clientSecretKey);

  const connectionSecret = crypto
    .randomBytes(32)
    .toString("hex");

  const connectionURI = createNostrConnectURI({
    clientPubkey,
    relays: NIP46_RELAYS,
    secret: connectionSecret,
    perms: REQUIRED_PERMISSIONS,
    name: "X to Nostr",
  });

  console.log("");
  console.log("================================");
  console.log("PRIMAL REMOTE SIGNER CONNECTION");
  console.log("================================");
  console.log("");
  console.log(
    "Open Primal Remote Signer and authorize this application:"
  );
  console.log("");
  console.log(connectionURI);
  console.log("");
  console.log(
    `Requested permissions: ${REQUIRED_PERMISSIONS.join(", ")}`
  );
  console.log("");
  console.log("Waiting for approval...");
  console.log("");

  const pool = new SimplePool();

  const signer = await BunkerSigner.fromURI(
    clientSecretKey,
    connectionURI,
    {
      pool,
      onauth(url) {
        console.log("");
        console.log(
          "Additional signer authentication required:"
        );
        console.log(url);
        console.log("");
      },
    },
    600_000
  );

  try {
    const userPubkey = await signer.getPublicKey();

    if (userPubkey !== expectedPubkey) {
      throw new Error(
        "Remote signer account does not match NOSTR_NPUB."
      );
    }

    await saveSession(signer, userPubkey);

    console.log("");
    console.log("NIP-46 authorization complete.");
    console.log(
      `Permissions: ${REQUIRED_PERMISSIONS.join(", ")}`
    );
    console.log(
      "Your nsec is NOT stored by this application."
    );
  } finally {
    try {
      await signer.close();
    } catch {}

    try {
      pool.close(signer.bp?.relays || []);
    } catch {}
  }
}

main().catch((error) => {
  console.error("");
  console.error("FATAL:");
  console.error(error.message);
  process.exit(1);
});