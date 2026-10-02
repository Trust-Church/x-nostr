import "dotenv/config";

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import WebSocket from "ws";

import {
  nip19,
  verifyEvent,
} from "nostr-tools";

import {
  BunkerSigner,
} from "nostr-tools/nip46";

import {
  SimplePool,
} from "nostr-tools/pool";

const NOSTR_NPUB =
  process.env.NOSTR_NPUB;

const TWEETS_FILE =
  "./tweets.json";

const CLIENT_KEY_FILE =
  "./.secrets/nip46-client.key";

const SESSION_FILE =
  "./.secrets/nip46-session.json";

const QUERY_TIMEOUT_MS =
  Number(
    process.env.NOSTR_QUERY_TIMEOUT_MS ||
    7000
  );

const PUBLISH_TIMEOUT_MS =
  Number(
    process.env.NOSTR_PUBLISH_TIMEOUT_MS ||
    10000
  );

const VERIFY_RETRIES =
  Number(
    process.env.NOSTR_VERIFY_RETRIES ||
    5
  );

const VERIFY_DELAY_MS =
  Number(
    process.env.NOSTR_VERIFY_DELAY_MS ||
    1000
  );

const PRIMAL_CACHE =
  process.env.PRIMAL_CACHE ||
  "wss://cache2.primal.net/v1";

const PRIMAL_PAGE_LIMIT =
  Number(
    process.env.PRIMAL_PAGE_LIMIT ||
    100
  );

const PRIMAL_MAX_PAGES =
  Number(
    process.env.PRIMAL_MAX_PAGES ||
    20
  );

const RELAYS = (
  process.env.NOSTR_RELAYS ||
  [
    "wss://relay.primal.net",
    "wss://relay.damus.io",
    "wss://nos.lol",
  ].join(",")
)
  .split(",")
  .map(
    (relay) =>
      relay.trim()
  )
  .filter(Boolean);

const BLOSSOM_SERVERS = (
  process.env.BLOSSOM_SERVERS ||
  [
    "https://blossom.primal.net",
    "https://cdn.nostr.build",
    "https://blossom.band",
  ].join(",")
)
  .split(",")
  .map(
    (server) =>
      server
        .trim()
        .replace(
          /\/+$/,
          ""
        )
  )
  .filter(Boolean);

function sleep(ms) {
  return new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        ms
      )
  );
}

function decodeHtmlEntities(
  text
) {
  return String(
    text ||
    ""
  )
    .replace(
      /&#x([0-9a-f]+);/giu,
      (
        original,
        hex
      ) => {
        const value =
          parseInt(
            hex,
            16
          );

        try {
          return String.fromCodePoint(
            value
          );
        } catch {
          return original;
        }
      }
    )
    .replace(
      /&#([0-9]+);/gu,
      (
        original,
        decimal
      ) => {
        const value =
          parseInt(
            decimal,
            10
          );

        try {
          return String.fromCodePoint(
            value
          );
        } catch {
          return original;
        }
      }
    )
    .replace(
      /&amp;/giu,
      "&"
    )
    .replace(
      /&lt;/giu,
      "<"
    )
    .replace(
      /&gt;/giu,
      ">"
    )
    .replace(
      /&quot;/giu,
      '"'
    )
    .replace(
      /&apos;/giu,
      "'"
    )
    .replace(
      /&nbsp;/giu,
      " "
    )
    .replace(
      /&#39;/giu,
      "'"
    );
}

function prepareContentForPublish(
  tweet
) {
  let text =
    decodeHtmlEntities(
      tweet?.text
    );

  const hasMedia =
    Array.isArray(
      tweet?.media
    ) &&
    tweet.media.length >
      0;

  /*
   * X often appends a t.co URL for
   * attached media.
   *
   * Remove only trailing t.co URLs
   * when media is present.
   *
   * Normal links inside the post are
   * preserved.
   */
  if (
    hasMedia
  ) {
    text =
      text.replace(
        /(?:\s*https?:\/\/t\.co\/[A-Za-z0-9]+\s*)+$/giu,
        ""
      );
  }

  return text
    .replace(
      /[ \t]+\n/g,
      "\n"
    )
    .replace(
      /\n{3,}/g,
      "\n\n"
    )
    .trim();
}

function stripUrlsForMatch(
  text
) {
  return decodeHtmlEntities(
    text
  )
    .replace(
      /https?:\/\/[^\s]+/giu,
      " "
    )
    .replace(
      /\bwww\.[^\s]+/giu,
      " "
    );
}

function normalizeForMatch(
  text
) {
  return stripUrlsForMatch(
    text
  )
    .normalize(
      "NFC"
    )

    /*
     * Ignore Unicode presentation
     * variation selectors for matching.
     *
     * Emoji characters remain intact.
     */
    .replace(
      /[\uFE00-\uFE0F]/gu,
      ""
    )
    .replace(
      /[\u{E0100}-\u{E01EF}]/gu,
      ""
    )

    /*
     * Remove invisible characters.
     *
     * U+200D is intentionally NOT
     * removed because it is required
     * for emoji ZWJ sequences.
     */
    .replace(
      /[\u200B\u200C\u2060\uFEFF]/gu,
      ""
    )

    .replace(
      /[\u2018\u2019\u201A\u201B]/gu,
      "'"
    )
    .replace(
      /[\u201C\u201D\u201E\u201F]/gu,
      '"'
    )
    .replace(
      /[\u2010\u2011\u2012\u2013\u2014\u2015]/gu,
      "-"
    )
    .replace(
      /\u2026/gu,
      "..."
    )
    .replace(
      /\r\n?/g,
      "\n"
    )
    .replace(
      /\u00A0/gu,
      " "
    )
    .replace(
      /\s+/gu,
      " "
    )
    .trim()
    .toLowerCase();
}

async function fileExists(
  file
) {
  try {
    await fs.access(
      file
    );

    return true;
  } catch {
    return false;
  }
}

async function loadTweets() {
  const raw =
    await fs.readFile(
      TWEETS_FILE,
      "utf8"
    );

  const tweets =
    JSON.parse(
      raw
    );

  if (
    !Array.isArray(
      tweets
    )
  ) {
    throw new Error(
      "tweets.json is not an array"
    );
  }

  return tweets;
}

async function saveTweets(
  tweets
) {
  await fs.writeFile(
    TWEETS_FILE,
    JSON.stringify(
      tweets,
      null,
      2
    )
  );
}

async function loadClientKey() {
  const hex = (
    await fs.readFile(
      CLIENT_KEY_FILE,
      "utf8"
    )
  ).trim();

  if (
    !/^[0-9a-f]{64}$/i.test(
      hex
    )
  ) {
    throw new Error(
      "Invalid NIP-46 client key."
    );
  }

  return new Uint8Array(
    Buffer.from(
      hex,
      "hex"
    )
  );
}

async function loadSession() {
  return JSON.parse(
    await fs.readFile(
      SESSION_FILE,
      "utf8"
    )
  );
}

function getExpectedPubkey() {
  if (
    !NOSTR_NPUB
  ) {
    throw new Error(
      "NOSTR_NPUB missing from .env"
    );
  }

  const decoded =
    nip19.decode(
      NOSTR_NPUB
    );

  if (
    decoded.type !==
    "npub"
  ) {
    throw new Error(
      "NOSTR_NPUB is not a valid npub"
    );
  }

  return decoded.data;
}

function getArchiveSince(
  tweets
) {
  const timestamps =
    tweets
      .map(
        (tweet) =>
          Date.parse(
            tweet.created_at
          )
      )
      .filter(
        Number.isFinite
      );

  if (
    !timestamps.length
  ) {
    return 0;
  }

  return Math.max(
    0,
    Math.floor(
      Math.min(
        ...timestamps
      ) /
      1000
    ) -
    86400
  );
}

function getOldestPendingTweet(
  tweets
) {
  return (
    tweets
      .filter(
        (tweet) =>
          tweet
            .nostr_published !==
          true
      )
      .filter(
        (tweet) => {
          const text =
            prepareContentForPublish(
              tweet
            );

          const images =
            Array.isArray(
              tweet.media
            )
              ? tweet.media.filter(
                  (media) =>
                    media.type ===
                      "photo" &&
                    media.local_path
                )
              : [];

          return (
            text.length >
              0 ||
            images.length >
              0
          );
        }
      )
      .sort(
        (a, b) =>
          Date.parse(
            a.created_at
          ) -
          Date.parse(
            b.created_at
          )
      )[0] ||
    null
  );
}

function mimeFromPath(
  file
) {
  switch (
    path
      .extname(
        file
      )
      .toLowerCase()
  ) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";

    case ".png":
      return "image/png";

    case ".webp":
      return "image/webp";

    case ".gif":
      return "image/gif";

    default:
      return "application/octet-stream";
  }
}

async function sha256File(
  file
) {
  const data =
    await fs.readFile(
      file
    );

  return {
    data,

    hash:
      crypto
        .createHash(
          "sha256"
        )
        .update(
          data
        )
        .digest(
          "hex"
        ),
  };
}

function queryRelay(
  relayUrl,
  filter,
  timeoutMs =
    QUERY_TIMEOUT_MS
) {
  return new Promise(
    (resolve) => {
      const events = [];

      const subId =
        `query-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`;

      let ws;
      let finished =
        false;

      const finish = (
        status = "ok",
        message = ""
      ) => {
        if (
          finished
        ) {
          return;
        }

        finished =
          true;

        clearTimeout(
          timer
        );

        try {
          if (
            ws?.readyState ===
            WebSocket.OPEN
          ) {
            ws.send(
              JSON.stringify([
                "CLOSE",
                subId,
              ])
            );
          }
        } catch {}

        try {
          ws?.terminate();
        } catch {}

        resolve({
          source:
            relayUrl,

          status,

          message,

          events,
        });
      };

      const timer =
        setTimeout(
          () =>
            finish(
              "timeout",
              "timeout"
            ),
          timeoutMs
        );

      try {
        ws =
          new WebSocket(
            relayUrl
          );
      } catch (
        error
      ) {
        finish(
          "failed",
          error.message
        );

        return;
      }

      ws.on(
        "open",
        () => {
          try {
            ws.send(
              JSON.stringify([
                "REQ",
                subId,
                filter,
              ])
            );
          } catch (
            error
          ) {
            finish(
              "failed",
              error.message
            );
          }
        }
      );

      ws.on(
        "message",
        (raw) => {
          let message;

          try {
            message =
              JSON.parse(
                raw.toString()
              );
          } catch {
            return;
          }

          if (
            message[0] ===
              "EVENT" &&
            message[1] ===
              subId
          ) {
            const event =
              message[2];

            try {
              if (
                event &&
                verifyEvent(
                  event
                )
              ) {
                events.push(
                  event
                );
              }
            } catch {}

            return;
          }

          if (
            message[0] ===
              "EOSE" &&
            message[1] ===
              subId
          ) {
            finish();

            return;
          }

          if (
            message[0] ===
              "CLOSED" &&
            message[1] ===
              subId
          ) {
            finish(
              "closed",
              String(
                message[2] ||
                "closed"
              )
            );

            return;
          }

          if (
            message[0] ===
            "AUTH"
          ) {
            finish(
              "auth-required",
              "authentication required"
            );
          }
        }
      );

      ws.on(
        "error",
        (error) => {
          finish(
            "failed",
            error.message
          );
        }
      );

      ws.on(
        "close",
        () => {
          if (
            !finished
          ) {
            finish(
              "closed",
              "connection closed"
            );
          }
        }
      );
    }
  );
}

function queryPrimalCache(
  request,
  timeoutMs =
    QUERY_TIMEOUT_MS
) {
  return new Promise(
    (resolve) => {
      const events = [];

      const subId =
        `primal-${Date.now()}-${Math.random()
          .toString(16)
          .slice(2)}`;

      let ws;
      let finished =
        false;

      const finish = (
        status = "ok",
        message = ""
      ) => {
        if (
          finished
        ) {
          return;
        }

        finished =
          true;

        clearTimeout(
          timer
        );

        try {
          if (
            ws?.readyState ===
            WebSocket.OPEN
          ) {
            ws.send(
              JSON.stringify([
                "CLOSE",
                subId,
              ])
            );
          }
        } catch {}

        try {
          ws?.terminate();
        } catch {}

        resolve({
          source:
            PRIMAL_CACHE,

          status,

          message,

          events,
        });
      };

      const timer =
        setTimeout(
          () =>
            finish(
              "timeout",
              "timeout"
            ),
          timeoutMs
        );

      try {
        ws =
          new WebSocket(
            PRIMAL_CACHE
          );
      } catch (
        error
      ) {
        finish(
          "failed",
          error.message
        );

        return;
      }

      ws.on(
        "open",
        () => {
          try {
            ws.send(
              JSON.stringify([
                "REQ",
                subId,
                {
                  cache:
                    request,
                },
              ])
            );
          } catch (
            error
          ) {
            finish(
              "failed",
              error.message
            );
          }
        }
      );

      ws.on(
        "message",
        (raw) => {
          let message;

          try {
            message =
              JSON.parse(
                raw.toString()
              );
          } catch {
            return;
          }

          if (
            message[0] ===
              "EVENT" &&
            message[1] ===
              subId
          ) {
            const event =
              message[2];

            try {
              if (
                event &&
                verifyEvent(
                  event
                )
              ) {
                events.push(
                  event
                );
              }
            } catch {}

            return;
          }

          if (
            message[0] ===
              "EOSE" &&
            message[1] ===
              subId
          ) {
            finish();
          }
        }
      );

      ws.on(
        "error",
        (error) => {
          finish(
            "failed",
            error.message
          );
        }
      );

      ws.on(
        "close",
        () => {
          if (
            !finished
          ) {
            finish(
              "closed",
              "connection closed"
            );
          }
        }
      );
    }
  );
}

function addValidAuthorNotes(
  target,
  events,
  pubkey
) {
  let added = 0;

  for (
    const event
    of events
  ) {
    if (
      event.kind !==
        1 ||
      event.pubkey !==
        pubkey
    ) {
      continue;
    }

    if (
      !target.has(
        event.id
      )
    ) {
      added++;
    }

    target.set(
      event.id,
      event
    );
  }

  return added;
}

async function fetchPrimalAuthorNotes(
  pubkey,
  since
) {
  const unique =
    new Map();

  let until =
    Math.floor(
      Date.now() /
      1000
    ) +
    60;

  let successfulPages =
    0;

  let previousOldest =
    null;

  for (
    let page = 1;
    page <=
    PRIMAL_MAX_PAGES;
    page++
  ) {
    const result =
      await queryPrimalCache([
        "feed",
        {
          pubkey,

          until,

          limit:
            PRIMAL_PAGE_LIMIT,
        },
      ]);

    if (
      result.status !==
      "ok"
    ) {
      console.log(
        `Primal cache page ${page} -> ${result.status}: ${result.message}`
      );

      if (
        page ===
        1
      ) {
        return {
          notes:
            unique,

          successfulPages,

          status:
            result.status,
        };
      }

      break;
    }

    successfulPages++;

    const authored =
      result.events.filter(
        (event) =>
          event.kind ===
            1 &&
          event.pubkey ===
            pubkey
      );

    const added =
      addValidAuthorNotes(
        unique,
        authored,
        pubkey
      );

    console.log(
      `Primal cache page ${page} -> ${authored.length} authored note(s), ${added} new`
    );

    if (
      !authored.length
    ) {
      break;
    }

    const oldest =
      Math.min(
        ...authored.map(
          (event) =>
            event.created_at
        )
      );

    if (
      oldest <=
      since
    ) {
      break;
    }

    if (
      previousOldest !==
        null &&
      oldest >=
        previousOldest
    ) {
      break;
    }

    previousOldest =
      oldest;

    until =
      oldest -
      1;

    if (
      added ===
      0
    ) {
      break;
    }
  }

  return {
    notes:
      unique,

    successfulPages,

    status:
      successfulPages >
      0
        ? "ok"
        : "failed",
  };
}

async function fetchAuthorNotes(
  pubkey,
  since
) {
  const relayFilter = {
    kinds: [
      1,
    ],

    authors: [
      pubkey,
    ],

    since,

    until:
      Math.floor(
        Date.now() /
        1000
      ) +
      60,

    limit:
      1000,
  };

  const [
    relayResults,
    primal,
  ] =
    await Promise.all([
      Promise.all(
        RELAYS.map(
          (relay) =>
            queryRelay(
              relay,
              relayFilter
            )
        )
      ),

      fetchPrimalAuthorNotes(
        pubkey,
        since
      ),
    ]);

  const unique =
    new Map();

  for (
    const result
    of relayResults
  ) {
    const added =
      addValidAuthorNotes(
        unique,
        result.events,
        pubkey
      );

    console.log(
      `${result.source} -> ${result.events.length} raw event(s), ${added} note(s) added${
        result.status ===
        "ok"
          ? ""
          : ` (${result.status}: ${result.message})`
      }`
    );
  }

  for (
    const event
    of primal.notes.values()
  ) {
    unique.set(
      event.id,
      event
    );
  }

  console.log(
    `Primal cache -> ${primal.notes.size} unique authored note(s) across ${primal.successfulPages} page(s)`
  );

  return {
    notes:
      unique,

    primalStatus:
      primal.status,

    relayResults,
  };
}

function findExistingMatch(
  tweet,
  notes
) {
  const target =
    normalizeForMatch(
      tweet.text
    );

  if (
    !target
  ) {
    return null;
  }

  const tweetTime =
    Date.parse(
      tweet.created_at
    ) /
    1000;

  const matches = [];

  for (
    const event
    of notes.values()
  ) {
    if (
      normalizeForMatch(
        event.content
      ) !==
      target
    ) {
      continue;
    }

    matches.push({
      event,

      distance:
        Number.isFinite(
          tweetTime
        )
          ? Math.abs(
              event.created_at -
              tweetTime
            )
          : 0,
    });
  }

  matches.sort(
    (a, b) =>
      a.distance -
      b.distance
  );

  return (
    matches[0]
      ?.event ||
    null
  );
}

async function createBlossomAuth(
  signer,
  server,
  hash
) {
  const now =
    Math.floor(
      Date.now() /
      1000
    );

  const hostname =
    new URL(
      server
    ).hostname;

  const event =
    await signer.signEvent({
      kind:
        24242,

      created_at:
        now,

      content:
        "Authorize upload",

      tags: [
        [
          "t",
          "upload",
        ],

        [
          "x",
          hash,
        ],

        [
          "expiration",
          String(
            now +
            300
          ),
        ],

        [
          "server",
          hostname,
        ],
      ],
    });

  if (
    !verifyEvent(
      event
    )
  ) {
    throw new Error(
      "Remote signer returned invalid Blossom authorization event."
    );
  }

  return (
    "Nostr " +
    Buffer
      .from(
        JSON.stringify(
          event
        )
      )
      .toString(
        "base64"
      )
  );
}

async function uploadToBlossomServer(
  signer,
  server,
  file
) {
  const absolutePath =
    path.resolve(
      file
    );

  const {
    data,
    hash,
  } =
    await sha256File(
      absolutePath
    );

  const mimeType =
    mimeFromPath(
      absolutePath
    );

  const authorization =
    await createBlossomAuth(
      signer,
      server,
      hash
    );

  const response =
    await fetch(
      `${server}/upload`,
      {
        method:
          "PUT",

        headers: {
          Authorization:
            authorization,

          "Content-Type":
            mimeType,

          "Content-Length":
            String(
              data.length
            ),

          "X-SHA-256":
            hash,
        },

        body:
          data,
      }
    );

  if (
    !response.ok
  ) {
    const body =
      await response.text();

    throw new Error(
      `${response.status} ${body}`
    );
  }

  const descriptor =
    await response.json();

  if (
    !descriptor.url
  ) {
    throw new Error(
      "Blossom server returned no URL."
    );
  }

  return {
    url:
      descriptor.url,

    sha256:
      descriptor.sha256 ||
      hash,

    size:
      descriptor.size ||
      data.length,

    type:
      descriptor.type ||
      mimeType,

    server,
  };
}

async function uploadImage(
  signer,
  media
) {
  if (
    media.blossom_url
  ) {
    return {
      url:
        media.blossom_url,

      sha256:
        media
          .blossom_sha256,

      size:
        media
          .blossom_size,

      type:
        media
          .blossom_type ||
        mimeFromPath(
          media.local_path
        ),

      server:
        media
          .blossom_server,
    };
  }

  if (
    !media.local_path
  ) {
    throw new Error(
      "Image has no local_path."
    );
  }

  const absolutePath =
    path.resolve(
      media.local_path
    );

  if (
    !(
      await fileExists(
        absolutePath
      )
    )
  ) {
    throw new Error(
      `Missing image: ${media.local_path}`
    );
  }

  let lastError =
    null;

  for (
    const server
    of BLOSSOM_SERVERS
  ) {
    console.log(
      `Uploading ${media.local_path} -> ${server}`
    );

    try {
      const result =
        await uploadToBlossomServer(
          signer,
          server,
          media.local_path
        );

      console.log(
        `Uploaded: ${result.url}`
      );

      return result;
    } catch (
      error
    ) {
      lastError =
        error;

      console.log(
        `Upload failed: ${error.message}`
      );
    }
  }

  throw new Error(
    `All Blossom uploads failed: ${
      lastError
        ?.message ||
      "unknown error"
    }`
  );
}

function buildImetaTag(
  media,
  upload
) {
  const tag = [
    "imeta",

    `url ${upload.url}`,

    `m ${upload.type}`,

    `x ${upload.sha256}`,

    `size ${upload.size}`,
  ];

  if (
    media.width &&
    media.height
  ) {
    tag.push(
      `dim ${media.width}x${media.height}`
    );
  }

  return tag;
}

function publishToRelay(
  relayUrl,
  event,
  signer
) {
  return new Promise(
    (resolve) => {
      let ws;

      let finished =
        false;

      let authEventId =
        null;

      let authAttempted =
        false;

      const finish = (
        accepted,
        message = ""
      ) => {
        if (
          finished
        ) {
          return;
        }

        finished =
          true;

        clearTimeout(
          timer
        );

        try {
          ws?.terminate();
        } catch {}

        resolve({
          relay:
            relayUrl,

          accepted,

          message,
        });
      };

      const handleAuth =
        async (
          challenge
        ) => {
          if (
            authAttempted
          ) {
            return;
          }

          authAttempted =
            true;

          try {
            const authEvent =
              await signer.signEvent({
                kind:
                  22242,

                created_at:
                  Math.floor(
                    Date.now() /
                    1000
                  ),

                content:
                  "",

                tags: [
                  [
                    "relay",
                    relayUrl,
                  ],

                  [
                    "challenge",
                    challenge,
                  ],
                ],
              });

            if (
              !verifyEvent(
                authEvent
              )
            ) {
              throw new Error(
                "Invalid NIP-42 auth event."
              );
            }

            authEventId =
              authEvent.id;

            ws.send(
              JSON.stringify([
                "AUTH",
                authEvent,
              ])
            );
          } catch (
            error
          ) {
            finish(
              false,
              `NIP-42 auth failed: ${error.message}`
            );
          }
        };

      const timer =
        setTimeout(
          () =>
            finish(
              false,
              "timeout"
            ),
          PUBLISH_TIMEOUT_MS
        );

      try {
        ws =
          new WebSocket(
            relayUrl
          );
      } catch (
        error
      ) {
        finish(
          false,
          error.message
        );

        return;
      }

      ws.on(
        "open",
        () => {
          try {
            ws.send(
              JSON.stringify([
                "EVENT",
                event,
              ])
            );
          } catch (
            error
          ) {
            finish(
              false,
              error.message
            );
          }
        }
      );

      ws.on(
        "message",
        (raw) => {
          let message;

          try {
            message =
              JSON.parse(
                raw.toString()
              );
          } catch {
            return;
          }

          if (
            message[0] ===
            "AUTH"
          ) {
            void handleAuth(
              message[1]
            );

            return;
          }

          if (
            message[0] !==
            "OK"
          ) {
            return;
          }

          const eventId =
            message[1];

          const accepted =
            Boolean(
              message[2]
            );

          const relayMessage =
            String(
              message[3] ||
              ""
            );

          if (
            authEventId &&
            eventId ===
              authEventId
          ) {
            if (
              accepted
            ) {
              try {
                ws.send(
                  JSON.stringify([
                    "EVENT",
                    event,
                  ])
                );
              } catch (
                error
              ) {
                finish(
                  false,
                  error.message
                );
              }
            } else {
              finish(
                false,
                `AUTH rejected: ${relayMessage}`
              );
            }

            return;
          }

          if (
            eventId !==
            event.id
          ) {
            return;
          }

          if (
            accepted ||
            relayMessage
              .toLowerCase()
              .startsWith(
                "duplicate:"
              )
          ) {
            finish(
              true,
              relayMessage
            );

            return;
          }

          if (
            /auth/i.test(
              relayMessage
            )
          ) {
            return;
          }

          finish(
            false,
            relayMessage ||
            "rejected"
          );
        }
      );

      ws.on(
        "error",
        (error) => {
          finish(
            false,
            error.message
          );
        }
      );

      ws.on(
        "close",
        () => {
          if (
            !finished
          ) {
            finish(
              false,
              "connection closed"
            );
          }
        }
      );
    }
  );
}

async function verifyPublishedEvent(
  eventId,
  pubkey
) {
  for (
    let attempt = 1;
    attempt <=
    VERIFY_RETRIES;
    attempt++
  ) {
    const [
      relayResults,
      primalResult,
    ] =
      await Promise.all([
        Promise.all(
          RELAYS.map(
            (relay) =>
              queryRelay(
                relay,
                {
                  ids: [
                    eventId,
                  ],

                  authors: [
                    pubkey,
                  ],

                  kinds: [
                    1,
                  ],

                  limit:
                    1,
                },

                QUERY_TIMEOUT_MS
              )
          )
        ),

        queryPrimalCache([
          "events",
          {
            event_ids: [
              eventId,
            ],
          },
        ]),
      ]);

    for (
      const result
      of relayResults
    ) {
      const found =
        result.events.find(
          (candidate) =>
            candidate.id ===
              eventId &&
            candidate.pubkey ===
              pubkey &&
            candidate.kind ===
              1
        );

      if (
        found
      ) {
        return {
          verified:
            true,

          relay:
            result.source,

          primalIndexed:
            primalResult.events.some(
              (candidate) =>
                candidate.id ===
                  eventId &&
                candidate.pubkey ===
                  pubkey &&
                candidate.kind ===
                  1
            ),

          event:
            found,
        };
      }
    }

    if (
      attempt <
      VERIFY_RETRIES
    ) {
      await sleep(
        VERIFY_DELAY_MS
      );
    }
  }

  return {
    verified:
      false,

    relay:
      null,

    primalIndexed:
      false,

    event:
      null,
  };
}

async function main() {
  const expectedPubkey =
    getExpectedPubkey();

  const tweets =
    await loadTweets();

  const tweet =
    getOldestPendingTweet(
      tweets
    );

  if (
    !tweet
  ) {
    console.log(
      "No publishable unpublished tweets."
    );

    return;
  }

  console.log(
    "================================"
  );

  console.log(
    "ONE-POST LIVE TEST"
  );

  console.log(
    "================================"
  );

  console.log(
    `Tweet ID: ${tweet.id}`
  );

  console.log(
    `Original X date: ${tweet.created_at}`
  );

  console.log("");

  console.log(
    prepareContentForPublish(
      tweet
    ) ||
    "[IMAGE ONLY]"
  );

  console.log("");

  console.log(
    "Checking complete Nostr history..."
  );

  const fetched =
    await fetchAuthorNotes(
      expectedPubkey,
      getArchiveSince(
        tweets
      )
    );

  /*
   * Fail closed.
   *
   * If Primal history cannot be
   * retrieved, do not publish.
   */
  if (
    fetched.primalStatus !==
    "ok"
  ) {
    throw new Error(
      "Primal cache history could not be loaded. Refusing to publish because duplicate detection is incomplete."
    );
  }

  const primalRelay =
    fetched.relayResults.find(
      (result) =>
        result.source ===
        "wss://relay.primal.net"
    );

  if (
    primalRelay &&
    primalRelay.status !==
      "ok"
  ) {
    throw new Error(
      "relay.primal.net history query failed. Refusing to publish because duplicate detection is incomplete."
    );
  }

  const notes =
    fetched.notes;

  console.log(
    `Unique kind-1 notes checked: ${notes.size}`
  );

  const existing =
    findExistingMatch(
      tweet,
      notes
    );

  if (
    existing
  ) {
    tweet.nostr_published =
      true;

    tweet.nostr_event_id =
      existing.id;

    tweet.nostr_published_at =
      new Date(
        existing.created_at *
        1000
      ).toISOString();

    tweet.nostr_match_method =
      "exact_unicode_normalized_text";

    tweet.nostr_reconciled_at =
      new Date()
        .toISOString();

    await saveTweets(
      tweets
    );

    console.log("");

    console.log(
      "ALREADY EXISTS ON NOSTR - NOTHING PUBLISHED"
    );

    console.log(
      `Event ID: ${existing.id}`
    );

    return;
  }

  console.log("");

  console.log(
    "No existing equivalent found."
  );

  const clientSecretKey =
    await loadClientKey();

  const session =
    await loadSession();

  const pool =
    new SimplePool();

  const signer =
    BunkerSigner.fromBunker(
      clientSecretKey,
      session.bunkerPointer,
      {
        pool,

        onauth(url) {
          console.log("");

          console.log(
            "Remote signer approval required:"
          );

          console.log(
            url
          );
        },
      }
    );

  try {
    const signerPubkey =
      await signer.getPublicKey();

    if (
      signerPubkey !==
      expectedPubkey
    ) {
      throw new Error(
        "NIP-46 signer does not match NOSTR_NPUB."
      );
    }

    console.log(
      "NIP-46 signer verified."
    );

    const images =
      Array.isArray(
        tweet.media
      )
        ? tweet.media.filter(
            (media) =>
              media.type ===
              "photo"
          )
        : [];

    const uploads = [];

    for (
      const media
      of images
    ) {
      const upload =
        await uploadImage(
          signer,
          media
        );

      media.blossom_url =
        upload.url;

      media.blossom_sha256 =
        upload.sha256;

      media.blossom_size =
        upload.size;

      media.blossom_type =
        upload.type;

      media.blossom_server =
        upload.server;

      uploads.push({
        media,
        upload,
      });

      await saveTweets(
        tweets
      );
    }

    let content =
      prepareContentForPublish(
        tweet
      );

    const tags = [];

    for (
      const {
        media,
        upload,
      }
      of uploads
    ) {
      if (
        content
      ) {
        content +=
          "\n\n";
      }

      content +=
        upload.url;

      tags.push(
        buildImetaTag(
          media,
          upload
        )
      );
    }

    if (
      !content
    ) {
      throw new Error(
        "Tweet has no publishable content."
      );
    }

    console.log("");

    console.log(
      "FINAL NOSTR CONTENT:"
    );

    console.log("");

    console.log(
      content
    );

    const event =
      await signer.signEvent({
        kind:
          1,

        created_at:
          Math.floor(
            Date.now() /
            1000
          ),

        content,

        tags,
      });

    if (
      event.pubkey !==
        expectedPubkey ||
      !verifyEvent(
        event
      )
    ) {
      throw new Error(
        "Remote signer returned an invalid event."
      );
    }

    console.log("");

    console.log(
      `Signed event: ${event.id}`
    );

    console.log(
      "Publishing to relays in parallel..."
    );

    const results =
      await Promise.all(
        RELAYS.map(
          (relay) =>
            publishToRelay(
              relay,
              event,
              signer
            )
        )
      );

    for (
      const result
      of results
    ) {
      console.log(
        `${
          result.accepted
            ? "OK"
            : "FAIL"
        } ${result.relay}${
          result.message
            ? ` -> ${result.message}`
            : ""
        }`
      );
    }

    const accepted =
      results.filter(
        (result) =>
          result.accepted
      );

    tweet.nostr_last_attempt_at =
      new Date()
        .toISOString();

    tweet.nostr_relay_results =
      results;

    if (
      !accepted.length
    ) {
      await saveTweets(
        tweets
      );

      throw new Error(
        "No relay accepted the event. Tweet remains unpublished."
      );
    }

    console.log("");

    console.log(
      "Verifying exact event ID..."
    );

    const verification =
      await verifyPublishedEvent(
        event.id,
        expectedPubkey
      );

    if (
      !verification.verified
    ) {
      tweet.nostr_publish_verified =
        false;

      tweet.nostr_candidate_event_id =
        event.id;

      await saveTweets(
        tweets
      );

      throw new Error(
        "Relay accepted the event, but exact event read-back failed. Tweet remains unpublished in tweets.json."
      );
    }

    tweet.nostr_published =
      true;

    tweet.nostr_publish_verified =
      true;

    tweet.nostr_event_id =
      event.id;

    tweet.nostr_published_at =
      new Date(
        event.created_at *
        1000
      ).toISOString();

    tweet.nostr_original_tweet_date =
      tweet.created_at;

    tweet.nostr_content =
      content;

    tweet.nostr_relays =
      accepted.map(
        (result) =>
          result.relay
      );

    tweet.nostr_verified_relay =
      verification.relay;

    tweet.nostr_primal_indexed =
      verification.primalIndexed;

    tweet.nostr_match_method =
      "published_by_crossposter";

    delete tweet
      .nostr_candidate_event_id;

    await saveTweets(
      tweets
    );

    console.log("");

    console.log(
      "================================"
    );

    console.log(
      "ONE POST PUBLISHED AND VERIFIED"
    );

    console.log(
      "================================"
    );

    console.log(
      `Event ID: ${event.id}`
    );

    console.log(
      `Created: ${new Date(
        event.created_at *
        1000
      ).toISOString()}`
    );

    console.log(
      `Verified relay: ${verification.relay}`
    );

    console.log(
      `Primal cache indexed: ${
        verification.primalIndexed
          ? "YES"
          : "NOT YET"
      }`
    );

    console.log("");

    console.log(
      "No other tweet was processed."
    );
  } finally {
    try {
      await signer.close();
    } catch {}

    try {
      pool.close(
        session
          .bunkerPointer
          ?.relays ||
        []
      );
    } catch {}
  }
}

main().catch(
  (error) => {
    console.error("");

    console.error(
      "FATAL:"
    );

    console.error(
      error.message
    );

    process.exit(1);
  }
);