import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;
const X_USERNAME = process.env.X_USERNAME;
const NOSTR_NPUB = process.env.NOSTR_NPUB;

const POLL_INTERVAL_MS =
  Number(process.env.POLL_INTERVAL_MS) || 15000;

const INITIAL_START_TIME = "2026-01-01T00:00:00Z";

const STATE_FILE = "./state.json";
const TWEETS_FILE = "./tweets.json";
const IMG_DIR = "./img";

const INITIAL_PAGE_SIZE = 100;
const LIVE_PAGE_SIZE = 10;
const MEDIA_LOOKUP_BATCH_SIZE = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(
      await fs.readFile(file, "utf8")
    );
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.writeFile(
    file,
    JSON.stringify(data, null, 2)
  );
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function ensureImgDir() {
  await fs.mkdir(
    IMG_DIR,
    {
      recursive: true,
    }
  );
}

async function loadState() {
  const state =
    await readJson(
      STATE_FILE,
      {}
    );

  return {
    xUserId:
      state.xUserId ||
      null,

    lastTweetId:
      state.lastTweetId ||
      null,

    initialImportComplete:
      state.initialImportComplete ===
      true,
  };
}

async function saveState(state) {
  await writeJson(
    STATE_FILE,
    state
  );
}

async function loadTweets() {
  const tweets =
    await readJson(
      TWEETS_FILE,
      []
    );

  return Array.isArray(tweets)
    ? tweets
    : [];
}

async function saveTweets(tweets) {
  tweets.sort(
    (a, b) => {
      const aId =
        BigInt(a.id);

      const bId =
        BigInt(b.id);

      if (aId < bId) {
        return -1;
      }

      if (aId > bId) {
        return 1;
      }

      return 0;
    }
  );

  await writeJson(
    TWEETS_FILE,
    tweets
  );
}

function sanitizeFilenamePart(value) {
  return String(
    value ||
    "media"
  ).replace(
    /[^a-zA-Z0-9_-]/g,
    "_"
  );
}

function extensionFromContentType(
  contentType
) {
  const value =
    String(
      contentType ||
      ""
    )
      .split(";")[0]
      .trim()
      .toLowerCase();

  switch (value) {
    case "image/jpeg":
      return "jpg";

    case "image/png":
      return "png";

    case "image/webp":
      return "webp";

    case "image/gif":
      return "gif";

    default:
      return null;
  }
}

function extensionFromUrl(url) {
  try {
    const parsed =
      new URL(url);

    const format =
      parsed.searchParams
        .get("format")
        ?.toLowerCase();

    if (
      [
        "jpg",
        "jpeg",
        "png",
        "webp",
        "gif",
      ].includes(format)
    ) {
      return format ===
        "jpeg"
        ? "jpg"
        : format;
    }

    const ext =
      path
        .extname(
          parsed.pathname
        )
        .replace(
          ".",
          ""
        )
        .toLowerCase();

    if (
      [
        "jpg",
        "jpeg",
        "png",
        "webp",
        "gif",
      ].includes(ext)
    ) {
      return ext ===
        "jpeg"
        ? "jpg"
        : ext;
    }
  } catch {}

  return null;
}

async function downloadMediaFile(
  tweetId,
  media,
  mediaIndex
) {
  const sourceUrl =
    media.type ===
    "photo"
      ? media.url
      : media.preview_image_url;

  if (!sourceUrl) {
    return {
      ...media,

      local_path:
        null,

      download_error:
        "No downloadable image URL returned by X",
    };
  }

  if (
    media.local_path &&
    await fileExists(
      path.resolve(
        media.local_path
      )
    )
  ) {
    return {
      ...media,
      download_error:
        null,
    };
  }

  try {
    const response =
      await fetch(
        sourceUrl
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const bytes =
      Buffer.from(
        await response
          .arrayBuffer()
      );

    const extension =
      extensionFromUrl(
        sourceUrl
      ) ||
      extensionFromContentType(
        response.headers.get(
          "content-type"
        )
      ) ||
      "jpg";

    const mediaKey =
      sanitizeFilenamePart(
        media.media_key ||
        mediaIndex + 1
      );

    const filename =
      `${tweetId}-${mediaKey}.${extension}`;

    const localPath =
      `img/${filename}`;

    const diskPath =
      path.resolve(
        localPath
      );

    await fs.writeFile(
      diskPath,
      bytes
    );

    return {
      ...media,

      local_path:
        localPath,

      download_error:
        null,
    };
  } catch (error) {
    return {
      ...media,

      local_path:
        media.local_path ||
        null,

      download_error:
        error.message,
    };
  }
}

function buildMediaMap(
  includesMedia = []
) {
  return new Map(
    includesMedia.map(
      (media) => [
        media.media_key,
        media,
      ]
    )
  );
}

async function applyMediaToTweet(
  archivedTweet,
  xTweet,
  mediaMap
) {
  const mediaKeys =
    xTweet.attachments
      ?.media_keys ||
    [];

  const existingMedia =
    new Map(
      (
        archivedTweet.media ||
        []
      ).map(
        (media) => [
          media.media_key,
          media,
        ]
      )
    );

  const media = [];

  for (
    let index = 0;
    index <
    mediaKeys.length;
    index++
  ) {
    const mediaKey =
      mediaKeys[index];

    const xMedia =
      mediaMap.get(
        mediaKey
      );

    if (!xMedia) {
      continue;
    }

    const previous =
      existingMedia.get(
        mediaKey
      ) ||
      {};

    const entry = {
      ...previous,

      media_key:
        mediaKey,

      type:
        xMedia.type ||
        previous.type ||
        null,

      source_url:
        xMedia.url ||
        previous.source_url ||
        null,

      preview_image_url:
        xMedia.preview_image_url ||
        previous.preview_image_url ||
        null,

      width:
        xMedia.width ??
        previous.width ??
        null,

      height:
        xMedia.height ??
        previous.height ??
        null,
    };

    const downloaded =
      await downloadMediaFile(
        archivedTweet.id,
        {
          ...entry,

          url:
            xMedia.url ||
            null,

          preview_image_url:
            xMedia.preview_image_url ||
            null,
        },
        index
      );

    delete downloaded.url;

    media.push(
      downloaded
    );
  }

  archivedTweet.media =
    media;

  archivedTweet.media_checked =
    true;

  archivedTweet.media_checked_at =
    new Date()
      .toISOString();

  archivedTweet.media_download_complete =
    media.every(
      (item) =>
        item.local_path ||
        (
          !item.source_url &&
          !item.preview_image_url
        )
    );

  return archivedTweet;
}

async function retryStoredMediaDownloads(
  tweets
) {
  let changed = false;

  for (
    const tweet
    of tweets
  ) {
    if (
      !Array.isArray(
        tweet.media
      )
    ) {
      continue;
    }

    for (
      let index = 0;
      index <
      tweet.media.length;
      index++
    ) {
      const media =
        tweet.media[
          index
        ];

      if (
        media.local_path &&
        await fileExists(
          path.resolve(
            media.local_path
          )
        )
      ) {
        continue;
      }

      const sourceUrl =
        media.type ===
        "photo"
          ? media.source_url
          : media.preview_image_url;

      if (!sourceUrl) {
        continue;
      }

      const updated =
        await downloadMediaFile(
          tweet.id,
          {
            ...media,

            url:
              media.type ===
              "photo"
                ? media.source_url
                : null,

            preview_image_url:
              media.preview_image_url ||
              null,
          },
          index
        );

      delete updated.url;

      tweet.media[
        index
      ] = updated;

      changed = true;
    }

    tweet.media_download_complete =
      tweet.media.every(
        (item) =>
          item.local_path ||
          (
            !item.source_url &&
            !item.preview_image_url
          )
      );
  }

  if (changed) {
    await saveTweets(
      tweets
    );
  }
}

async function archiveTweets(
  newTweets,
  includesMedia = []
) {
  const tweets =
    await loadTweets();

  const mediaMap =
    buildMediaMap(
      includesMedia
    );

  const byId =
    new Map(
      tweets.map(
        (tweet) => [
          tweet.id,
          tweet,
        ]
      )
    );

  let added = 0;
  let enriched = 0;

  for (
    const xTweet
    of newTweets
  ) {
    let archived =
      byId.get(
        xTweet.id
      );

    if (!archived) {
      archived = {
        id:
          xTweet.id,

        text:
          xTweet.text,

        created_at:
          xTweet.created_at ||
          null,

        nostr_published:
          false,

        nostr_event_id:
          null,

        nostr_published_at:
          null,
      };

      byId.set(
        xTweet.id,
        archived
      );

      added++;
    }

    /*
     * Existing tweet text is NEVER rewritten.
     *
     * Media information may be added to
     * existing tweets.
     */
    if (
      xTweet.attachments
        ?.media_keys
        ?.length
    ) {
      await applyMediaToTweet(
        archived,
        xTweet,
        mediaMap
      );

      enriched++;
    } else if (
      archived.media_checked !==
      true
    ) {
      archived.media =
        archived.media ||
        [];

      archived.media_checked =
        true;

      archived.media_checked_at =
        new Date()
          .toISOString();

      archived.media_download_complete =
        true;
    }
  }

  await saveTweets(
    Array.from(
      byId.values()
    )
  );

  return {
    added,
    enriched,
  };
}

function getNewestTweetId(
  tweets
) {
  if (!tweets.length) {
    return null;
  }

  let newest =
    tweets[0].id;

  for (
    const tweet
    of tweets
  ) {
    if (
      BigInt(
        tweet.id
      ) >
      BigInt(
        newest
      )
    ) {
      newest =
        tweet.id;
    }
  }

  return newest;
}

async function xRequest(
  pathname
) {
  const response =
    await fetch(
      `https://api.x.com/2${pathname}`,
      {
        headers: {
          Authorization:
            `Bearer ${X_BEARER_TOKEN}`,
        },
      }
    );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `X API ${response.status}: ${body}`
    );
  }

  return response.json();
}

async function resolveXUserId(
  state
) {
  if (
    state.xUserId
  ) {
    console.log(
      `Using cached X user ID: ${state.xUserId}`
    );

    return state.xUserId;
  }

  console.log(
    `Resolving @${X_USERNAME}...`
  );

  const result =
    await xRequest(
      `/users/by/username/${encodeURIComponent(
        X_USERNAME
      )}`
    );

  if (
    !result.data?.id
  ) {
    throw new Error(
      `Could not resolve @${X_USERNAME}`
    );
  }

  state.xUserId =
    result.data.id;

  await saveState(
    state
  );

  console.log(
    `Cached X user ID: ${state.xUserId}`
  );

  return state.xUserId;
}

async function repairState(
  state
) {
  const tweets =
    await loadTweets();

  if (
    state.initialImportComplete &&
    tweets.length === 0
  ) {
    console.log(
      "Repairing invalid import state..."
    );

    state.initialImportComplete =
      false;

    state.lastTweetId =
      null;

    await saveState(
      state
    );
  }

  if (
    tweets.length >
    0
  ) {
    const newest =
      getNewestTweetId(
        tweets
      );

    if (
      state.initialImportComplete &&
      state.lastTweetId !==
      newest
    ) {
      state.lastTweetId =
        newest;

      await saveState(
        state
      );
    }
  }
}

function mediaQueryParams() {
  return {
    tweetFields:
      "created_at,attachments",

    expansions:
      "attachments.media_keys",

    mediaFields:
      "media_key,type,url,preview_image_url,width,height",
  };
}

async function initialImport(
  userId,
  state
) {
  console.log("");
  console.log(
    "============================"
  );
  console.log(
    "INITIAL X IMPORT"
  );
  console.log(
    "============================"
  );

  console.log(
    `Importing since ${INITIAL_START_TIME}`
  );

  let paginationToken =
    null;

  let page = 1;

  const mediaParams =
    mediaQueryParams();

  do {
    const params =
      new URLSearchParams();

    params.set(
      "start_time",
      INITIAL_START_TIME
    );

    params.set(
      "max_results",
      String(
        INITIAL_PAGE_SIZE
      )
    );

    params.set(
      "tweet.fields",
      mediaParams.tweetFields
    );

    params.set(
      "expansions",
      mediaParams.expansions
    );

    params.set(
      "media.fields",
      mediaParams.mediaFields
    );

    params.set(
      "exclude",
      "retweets,replies"
    );

    if (
      paginationToken
    ) {
      params.set(
        "pagination_token",
        paginationToken
      );
    }

    console.log(
      `Fetching historical page ${page}...`
    );

    const result =
      await xRequest(
        `/users/${userId}/tweets?${params.toString()}`
      );

    const fetched =
      result.data ||
      [];

    const archived =
      await archiveTweets(
        fetched,
        result.includes
          ?.media ||
          []
      );

    const localTweets =
      await loadTweets();

    console.log(
      `Fetched: ${fetched.length} | ` +
      `New: ${archived.added} | ` +
      `Stored: ${localTweets.length}`
    );

    paginationToken =
      result.meta
        ?.next_token ||
      null;

    page++;
  } while (
    paginationToken
  );

  const tweets =
    await loadTweets();

  if (
    tweets.length ===
    0
  ) {
    throw new Error(
      "Historical import returned zero tweets. " +
      "Import was NOT marked complete."
    );
  }

  const newest =
    getNewestTweetId(
      tweets
    );

  state.lastTweetId =
    newest;

  state.initialImportComplete =
    true;

  await saveState(
    state
  );

  console.log("");

  console.log(
    "Historical import complete."
  );

  console.log(
    `Stored locally: ${tweets.length}`
  );

  console.log(
    `lastTweetId: ${state.lastTweetId}`
  );
}

function chunkArray(
  items,
  size
) {
  const chunks = [];

  for (
    let index = 0;
    index <
    items.length;
    index += size
  ) {
    chunks.push(
      items.slice(
        index,
        index + size
      )
    );
  }

  return chunks;
}

async function enrichExistingTweetMedia() {
  const tweets =
    await loadTweets();

  /*
   * Retry downloads where we already have
   * X media metadata.
   *
   * This does NOT call the X API.
   */
  await retryStoredMediaDownloads(
    tweets
  );

  const refreshedTweets =
    await loadTweets();

  /*
   * Only tweets that have never had their
   * media checked are sent to the X lookup.
   *
   * Existing text is never pulled again.
   */
  const unchecked =
    refreshedTweets.filter(
      (tweet) =>
        tweet.media_checked !==
        true
    );

  if (
    !unchecked.length
  ) {
    console.log(
      "Media archive already checked. No X media backfill needed."
    );

    return;
  }

  const batches =
    chunkArray(
      unchecked,
      MEDIA_LOOKUP_BATCH_SIZE
    );

  console.log("");
  console.log(
    "============================"
  );
  console.log(
    "MEDIA BACKFILL"
  );
  console.log(
    "============================"
  );

  console.log(
    `${unchecked.length} existing tweet(s) need a one-time media check.`
  );

  console.log(
    `${batches.length} X lookup request(s) required.`
  );

  const mediaParams =
    mediaQueryParams();

  for (
    let batchIndex = 0;
    batchIndex <
    batches.length;
    batchIndex++
  ) {
    const batch =
      batches[
        batchIndex
      ];

    const params =
      new URLSearchParams();

    params.set(
      "ids",
      batch
        .map(
          (tweet) =>
            tweet.id
        )
        .join(",")
    );

    /*
     * We are NOT requesting text again here.
     *
     * We only need attachment references.
     */
    params.set(
      "tweet.fields",
      "attachments"
    );

    params.set(
      "expansions",
      mediaParams.expansions
    );

    params.set(
      "media.fields",
      mediaParams.mediaFields
    );

    console.log(
      `Checking media batch ${batchIndex + 1}/${batches.length}...`
    );

    const result =
      await xRequest(
        `/tweets?${params.toString()}`
      );

    const returnedTweets =
      result.data ||
      [];

    const returnedById =
      new Map(
        returnedTweets.map(
          (tweet) => [
            tweet.id,
            tweet,
          ]
        )
      );

    const mediaMap =
      buildMediaMap(
        result.includes
          ?.media ||
          []
      );

    const localTweets =
      await loadTweets();

    const localById =
      new Map(
        localTweets.map(
          (tweet) => [
            tweet.id,
            tweet,
          ]
        )
      );

    let foundImages =
      0;

    for (
      const requested
      of batch
    ) {
      const local =
        localById.get(
          requested.id
        );

      if (!local) {
        continue;
      }

      const xTweet =
        returnedById.get(
          requested.id
        );

      if (!xTweet) {
        local.media =
          local.media ||
          [];

        local.media_checked =
          true;

        local.media_checked_at =
          new Date()
            .toISOString();

        local.media_download_complete =
          true;

        local.media_check_error =
          "Tweet was not returned by X lookup";

        continue;
      }

      delete local
        .media_check_error;

      if (
        xTweet.attachments
          ?.media_keys
          ?.length
      ) {
        await applyMediaToTweet(
          local,
          xTweet,
          mediaMap
        );

        foundImages +=
          local.media
            ?.filter(
              (media) =>
                media.type ===
                "photo"
            )
            .length ||
          0;
      } else {
        local.media =
          local.media ||
          [];

        local.media_checked =
          true;

        local.media_checked_at =
          new Date()
            .toISOString();

        local.media_download_complete =
          true;
      }
    }

    /*
     * Save after every batch so we never
     * redo completed media checks.
     */
    await saveTweets(
      localTweets
    );

    console.log(
      `Batch complete. Image attachment(s) found: ${foundImages}`
    );
  }

  const finalTweets =
    await loadTweets();

  const imageCount =
    finalTweets.reduce(
      (
        total,
        tweet
      ) =>
        total +
        (
          tweet.media ||
          []
        ).filter(
          (media) =>
            media.type ===
              "photo" &&
            media.local_path
        ).length,
      0
    );

  console.log(
    `Local image files stored: ${imageCount}`
  );
}

async function fetchNewTweets(
  userId,
  sinceId
) {
  const collectedTweets =
    [];

  const collectedMedia =
    new Map();

  let paginationToken =
    null;

  const mediaParams =
    mediaQueryParams();

  do {
    const params =
      new URLSearchParams();

    params.set(
      "since_id",
      sinceId
    );

    params.set(
      "max_results",
      String(
        LIVE_PAGE_SIZE
      )
    );

    params.set(
      "tweet.fields",
      mediaParams.tweetFields
    );

    params.set(
      "expansions",
      mediaParams.expansions
    );

    params.set(
      "media.fields",
      mediaParams.mediaFields
    );

    params.set(
      "exclude",
      "retweets,replies"
    );

    if (
      paginationToken
    ) {
      params.set(
        "pagination_token",
        paginationToken
      );
    }

    const result =
      await xRequest(
        `/users/${userId}/tweets?${params.toString()}`
      );

    if (
      result.data
    ) {
      collectedTweets.push(
        ...result.data
      );
    }

    for (
      const media
      of result.includes
        ?.media ||
      []
    ) {
      collectedMedia.set(
        media.media_key,
        media
      );
    }

    paginationToken =
      result.meta
        ?.next_token ||
      null;
  } while (
    paginationToken
  );

  return {
    tweets:
      collectedTweets,

    media:
      Array.from(
        collectedMedia.values()
      ),
  };
}

async function publishStoredTweet(
  tweet
) {
  /*
   * NIP-46 publishing will eventually
   * consume only the local archive.
   */

  console.log("");
  console.log(
    "PENDING NOSTR"
  );
  console.log(
    "-------------"
  );

  console.log(
    tweet.created_at
  );

  console.log(
    tweet.text
  );

  if (
    tweet.media
      ?.length
  ) {
    console.log(
      "MEDIA:"
    );

    for (
      const media
      of tweet.media
    ) {
      if (
        media.local_path
      ) {
        console.log(
          `  ${media.local_path}`
        );
      }
    }
  }

  console.log(
    `https://x.com/${X_USERNAME}/status/${tweet.id}`
  );
}

async function processNostrQueue() {
  const tweets =
    await loadTweets();

  const pending =
    tweets.filter(
      (tweet) =>
        !tweet
          .nostr_published
    );

  if (
    !pending.length
  ) {
    return;
  }

  console.log("");

  console.log(
    `${pending.length} tweet(s) pending Nostr publication.`
  );

  for (
    const tweet
    of pending
  ) {
    await publishStoredTweet(
      tweet
    );
  }
}

async function monitorTweets(
  userId,
  state
) {
  console.log("");
  console.log(
    "============================"
  );
  console.log(
    "LIVE MONITORING"
  );
  console.log(
    "============================"
  );

  console.log(
    `Polling every ${
      POLL_INTERVAL_MS /
      1000
    } seconds`
  );

  console.log(
    `since_id: ${state.lastTweetId}`
  );

  while (true) {
    try {
      const result =
        await fetchNewTweets(
          userId,
          state.lastTweetId
        );

      const fetched =
        result.tweets;

      if (
        fetched.length
      ) {
        /*
         * New tweets include their media metadata
         * on the same API request.
         */
        const archived =
          await archiveTweets(
            fetched,
            result.media
          );

        const tweets =
          await loadTweets();

        const newest =
          getNewestTweetId(
            tweets
          );

        state.lastTweetId =
          newest;

        await saveState(
          state
        );

        console.log(
          `New tweets: ${fetched.length} | ` +
          `Archived: ${archived.added} | ` +
          `Total stored: ${tweets.length}`
        );

        await processNostrQueue();
      }
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}]`,
        error.message
      );
    }

    await sleep(
      POLL_INTERVAL_MS
    );
  }
}

async function main() {
  if (
    !X_BEARER_TOKEN
  ) {
    throw new Error(
      "X_BEARER_TOKEN missing from .env"
    );
  }

  if (
    !NOSTR_NPUB
  ) {
    throw new Error(
      "NOSTR_NPUB missing from .env"
    );
  }

  /*
   * Images live here permanently so the
   * Nostr uploader can reference them later.
   */
  await ensureImgDir();

  console.log(
    "============================"
  );
  console.log(
    "X -> Nostr"
  );
  console.log(
    "============================"
  );

  console.log(
    `X: @${X_USERNAME}`
  );

  console.log(
    `Nostr: ${NOSTR_NPUB}`
  );

  const state =
    await loadState();

  await repairState(
    state
  );

  const userId =
    await resolveXUserId(
      state
    );

  /*
   * Historical timeline import remains unchanged.
   *
   * If it already completed, it is NOT run again.
   */
  if (
    !state
      .initialImportComplete
  ) {
    await initialImport(
      userId,
      state
    );
  }

  /*
   * Existing archived tweets:
   *
   * - text is left untouched
   * - only tweets without media_checked=true
   *   are checked against X
   * - checks are batched
   * - images are downloaded to ./img/
   * - local_path is stored in tweets.json
   */
  await enrichExistingTweetMedia();

  const tweets =
    await loadTweets();

  if (
    !tweets.length
  ) {
    throw new Error(
      "Local tweet archive is empty. " +
      "Refusing to enter live mode."
    );
  }

  if (
    !state.lastTweetId
  ) {
    throw new Error(
      "lastTweetId missing. " +
      "Refusing to enter live mode."
    );
  }

  console.log("");

  console.log(
    `Local archive: ${tweets.length} tweets`
  );

  await processNostrQueue();

  await monitorTweets(
    userId,
    state
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