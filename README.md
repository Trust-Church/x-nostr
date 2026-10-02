# X → Nostr

An open-source Node.js tool for archiving posts from X and publishing posts that do not already exist on Nostr.

It supports text, emoji, images, duplicate detection, NIP-46 remote signing, Blossom uploads, and local post tracking.

## Why This Exists

This project was created and released by [Trust Church](https://www.trustchurch.org/) as part of our effort to use technology and open-source software to reach people where they are.

Trust Church exists to encourage people to love God, love others, grow in faith, serve others, and live out the teachings of Jesus Christ.

This software is intentionally **not specific to Trust Church**. Anyone can download it, configure their own X and Nostr accounts, modify it, and run it themselves.

If this project helps someone discover Nostr, open-source technology, Trust Church, or ultimately learn more about Jesus and God, then it has served a greater purpose than simply moving posts between social networks.

## Trust Church

- Website: https://www.trustchurch.org/
- X: https://x.com/TrustChurchorg
- Nostr: https://primal.net/trustchurch
- GitHub: https://github.com/Trust-Church

## Features

- Archive posts from X locally
- Download attached images
- Compare X posts against existing Nostr notes
- Prevent duplicate publishing
- Preserve Unicode and emoji
- Decode HTML entities from X
- Upload images using Blossom
- Sign events using NIP-46
- Verify published Nostr events

## Security

The Nostr private key (`nsec`) is **never stored by the application**.

Signing is handled through **NIP-46 remote signing**.

Keep these files private and out of Git:

```text
.env
.secrets/
tweets.json
state.json
```

`.env` contains API credentials, while `.secrets/` contains the local NIP-46 client key and session information—not the Nostr account's private key.

## Setup

```bash
git clone https://github.com/Trust-Church/x-nostr.git
cd x-nostr
npm install
cp sample.env .env
```

Configure `.env` with your own:

- X API bearer token
- X username
- Nostr public key (`npub`)
- Relays and optional settings

Then authorize your Nostr signer:

```bash
npm run setup:nostr
```

## Usage

Archive and monitor X:

```bash
npm start
```

Compare archived X posts with existing Nostr posts:

```bash
npm run match
```

Publish unmatched posts:

```bash
npm run publish
```

Run `npm run match` before migrating historical content.

## Open Source

This project is provided so others can use, modify, improve, and build on it.

Technology is a tool. We hope this one helps people communicate more freely—and, through its origins, points a few more people toward Christ.

**Love God. Love people. Live it out.**