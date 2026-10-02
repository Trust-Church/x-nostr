import "dotenv/config";
import fs from "node:fs/promises";
import WebSocket from "ws";
import {
  nip19,
  verifyEvent,
} from "nostr-tools";

const NOSTR_NPUB =
  process.env.NOSTR_NPUB;

const TWEETS_FILE =
  "./tweets.json";

const QUERY_TIMEOUT_MS =
  Number(
    process.env.NOSTR_QUERY_TIMEOUT_MS ||
    7000
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
     * Remove invisible formatting
     * characters.
     *
     * U+200D is intentionally preserved
     * because it is required for emoji
     * ZWJ sequences.
     */
    .replace(
      /[\u200B\u200C\u2060\uFEFF]/gu,
      ""
    )

    /*
     * Normalize equivalent punctuation.
     */
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
        `match-${Date.now()}-${Math.random()
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

    primalPages:
      primal.successfulPages,

    relayResults,
  };
}

async function fetchEventsByIds(
  pubkey,
  ids
) {
  const unique =
    new Map();

  if (
    !ids.length
  ) {
    return unique;
  }

  for (
    let index = 0;
    index <
    ids.length;
    index +=
    100
  ) {
    const chunk =
      ids.slice(
        index,
        index +
        100
      );

    const results =
      await Promise.all([
        ...RELAYS.map(
          (relay) =>
            queryRelay(
              relay,
              {
                ids:
                  chunk,

                authors: [
                  pubkey,
                ],

                kinds: [
                  1,
                ],

                limit:
                  chunk.length,
              }
            )
        ),

        queryPrimalCache([
          "events",
          {
            event_ids:
              chunk,
          },
        ]),
      ]);

    for (
      const result
      of results
    ) {
      addValidAuthorNotes(
        unique,
        result.events,
        pubkey
      );
    }
  }

  return unique;
}

function chooseBestMatch(
  tweet,
  notes,
  usedEventIds
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
      usedEventIds.has(
        event.id
      )
    ) {
      continue;
    }

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

async function main() {
  const pubkey =
    getExpectedPubkey();

  const tweets =
    await loadTweets();

  const since =
    getArchiveSince(
      tweets
    );

  console.log(
    `Loaded ${tweets.length} tweets from tweets.json`
  );

  console.log("");

  console.log(
    "Fetching Nostr history..."
  );

  const fetched =
    await fetchAuthorNotes(
      pubkey,
      since
    );

  if (
    fetched.primalStatus !==
    "ok"
  ) {
    throw new Error(
      "Primal cache history could not be loaded. Refusing to reconcile tweets.json from a partial source set."
    );
  }

  const notes =
    fetched.notes;

  console.log("");

  console.log(
    `Unique kind-1 notes available: ${notes.size}`
  );

  const storedIds =
    Array.from(
      new Set(
        tweets
          .map(
            (tweet) =>
              tweet
                .nostr_event_id
          )
          .filter(
            (id) =>
              typeof id ===
                "string" &&
              /^[0-9a-f]{64}$/i.test(
                id
              )
          )
      )
    );

  const verifiedStored =
    await fetchEventsByIds(
      pubkey,
      storedIds
    );

  for (
    const event
    of verifiedStored.values()
  ) {
    notes.set(
      event.id,
      event
    );
  }

  const usedEventIds =
    new Set();

  let matched = 0;
  let unmatched = 0;

  const orderedTweets =
    [
      ...tweets,
    ].sort(
      (a, b) =>
        Date.parse(
          a.created_at
        ) -
        Date.parse(
          b.created_at
        )
    );

  for (
    const tweet
    of orderedTweets
  ) {
    let match =
      null;

    if (
      tweet.nostr_event_id &&
      verifiedStored.has(
        tweet.nostr_event_id
      )
    ) {
      const stored =
        verifiedStored.get(
          tweet.nostr_event_id
        );

      if (
        !usedEventIds.has(
          stored.id
        ) &&
        normalizeForMatch(
          stored.content
        ) ===
          normalizeForMatch(
            tweet.text
          )
      ) {
        match =
          stored;
      }
    }

    if (
      !match
    ) {
      match =
        chooseBestMatch(
          tweet,
          notes,
          usedEventIds
        );
    }

    if (
      match
    ) {
      usedEventIds.add(
        match.id
      );

      tweet.nostr_published =
        true;

      tweet.nostr_event_id =
        match.id;

      tweet.nostr_published_at =
        new Date(
          match.created_at *
          1000
        ).toISOString();

      tweet.nostr_match_method =
        "exact_unicode_normalized_text";

      tweet.nostr_reconciled_at =
        new Date()
          .toISOString();

      matched++;

      continue;
    }

    tweet.nostr_published =
      false;

    tweet.nostr_event_id =
      null;

    tweet.nostr_published_at =
      null;

    tweet.nostr_match_method =
      null;

    tweet.nostr_reconciled_at =
      new Date()
        .toISOString();

    unmatched++;
  }

  await saveTweets(
    tweets
  );

  console.log("");

  console.log(
    "============================"
  );

  console.log(
    `Matched:   ${matched}`
  );

  console.log(
    `Unmatched: ${unmatched}`
  );

  console.log(
    `Total:     ${tweets.length}`
  );

  console.log(
    "============================"
  );

  console.log("");

  console.log(
    "tweets.json reconciled."
  );
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