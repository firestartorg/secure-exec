#!/usr/bin/env python3
"""Add user stories US-165 through US-189 to prd.json."""

import json
import sys

PRD_PATH = "/home/nathan/secure-exec-1/scripts/ralph/prd.json"

new_stories = [
    # Category 1: Compat Doc Updates
    {
        "id": "US-165",
        "title": "Update nodejs-compatibility.mdx with current implementation state",
        "description": "As a developer, I need the Node.js compatibility doc to accurately reflect the current implementation state.",
        "acceptanceCriteria": [
            "fs entry updated: move chmod, chown, link, symlink, readlink, truncate, utimes from Deferred to Implemented; add cp, mkdtemp, opendir, glob, statfs, readv, fdatasync, fsync to Implemented list; only watch/watchFile remain as Deferred",
            "http/https entries updated: mention Agent pooling, upgrade handling, and trailer headers support from US-043",
            "async_hooks entry updated: move from Deferred (Tier 4) to Stub (Tier 3) with note about AsyncLocalStorage, AsyncResource, createHook stubs",
            "diagnostics_channel entry: move from Unsupported (Tier 5) to Stub (Tier 3) with note about no-op channel/tracingChannel stubs",
            "punycode entry added as Tier 2 Polyfill",
            "Add \"Tested Packages\" section listing all project-matrix fixtures with link to request new packages",
            "Typecheck passes"
        ],
        "priority": 165,
        "passes": False,
        "notes": "The doc has several stale entries from before US-033/034/035/043 were implemented. Also needs new Tested Packages section."
    },
    {
        "id": "US-166",
        "title": "Update cloudflare-workers-comparison.mdx with current implementation state",
        "description": "As a developer, I need the CF Workers comparison doc to accurately reflect the current secure-exec implementation state.",
        "acceptanceCriteria": [
            "fs row updated: remove chmod/chown/link/symlink/readlink/truncate/utimes from Deferred list, add cp/mkdtemp/opendir/glob/statfs/readv/fdatasync/fsync to Implemented, change icon from \U0001f7e1 to reflect broader coverage",
            "http row updated: mention Agent pooling, upgrade, trailer support",
            "async_hooks row: change from \u26aa TBD to \U0001f534 Stub with note about AsyncLocalStorage/AsyncResource/createHook",
            "diagnostics_channel row: change from \u26aa TBD to \U0001f534 Stub with note about no-op stubs",
            "punycode row: add to Utilities section as \U0001f7e2 Supported",
            "Update \"Last updated\" date to 2026-03-18",
            "Typecheck passes"
        ],
        "priority": 166,
        "passes": False,
        "notes": "CF Workers doc has same staleness issues as Node compat doc."
    },
    {
        "id": "US-167",
        "title": "Verify nodejs-compatibility.mdx and cloudflare-workers-comparison.mdx are comprehensive",
        "description": "As a developer, I need a final verification pass ensuring both compat docs match the actual bridge/polyfill/stub implementations.",
        "acceptanceCriteria": [
            "Cross-reference every module in require-setup.ts deferred/unsupported lists against both docs",
            "Cross-reference every bridge file in src/bridge/ against both docs",
            "Cross-reference every polyfill in src/generated/polyfills.ts against both docs",
            "Verify no module is listed in wrong tier",
            "Verify all API listings match actual exported functions",
            "Typecheck passes"
        ],
        "priority": 167,
        "passes": False,
        "notes": "Final verification pass after US-165 and US-166 update the docs."
    },

    # Category 2: Crypto Implementation
    {
        "id": "US-168",
        "title": "Implement crypto.createHash and crypto.createHmac in bridge",
        "description": "As a developer, I need createHash and createHmac so packages like jsonwebtoken and bcryptjs work in the sandbox.",
        "acceptanceCriteria": [
            "crypto.createHash(algorithm) returns Hash object with update(data) and digest(encoding) methods",
            "Supported algorithms: sha1, sha256, sha384, sha512, md5",
            "crypto.createHmac(algorithm, key) returns Hmac object with update(data) and digest(encoding) methods",
            "Hash/Hmac objects are streams (support pipe)",
            "Host-side implementation uses node:crypto for actual computation",
            "Test: createHash('sha256').update('hello').digest('hex') matches Node.js output",
            "Test: createHmac('sha256', 'key').update('data').digest('hex') matches Node.js output",
            "Typecheck passes",
            "Tests pass"
        ],
        "priority": 168,
        "passes": False,
        "notes": "Foundation for jsonwebtoken, bcryptjs, and many other packages. Bridge call sends data to host, host computes hash."
    },
    {
        "id": "US-169",
        "title": "Implement crypto.randomBytes, randomInt, and randomFill in bridge",
        "description": "As a developer, I need randomBytes/randomInt/randomFill for packages that use Node.js crypto randomness APIs beyond getRandomValues/randomUUID.",
        "acceptanceCriteria": [
            "crypto.randomBytes(size) returns Buffer of random bytes (sync) and supports callback variant",
            "crypto.randomInt([min,] max[, callback]) returns random integer in range",
            "crypto.randomFillSync(buffer[, offset[, size]]) fills buffer with random bytes",
            "crypto.randomFill(buffer[, offset[, size]], callback) async variant",
            "Size capped at 65536 bytes per call (matches Web Crypto spec limit for getRandomValues)",
            "Test: randomBytes(32) returns 32-byte Buffer",
            "Test: randomInt(0, 100) returns integer in [0, 100)",
            "Typecheck passes",
            "Tests pass"
        ],
        "priority": 169,
        "passes": False,
        "notes": "Extends existing crypto randomness bridge. Many packages use randomBytes instead of getRandomValues."
    },
    {
        "id": "US-170",
        "title": "Implement crypto.pbkdf2 and crypto.scrypt in bridge",
        "description": "As a developer, I need key derivation functions for password hashing packages.",
        "acceptanceCriteria": [
            "crypto.pbkdf2(password, salt, iterations, keylen, digest, callback) derives key",
            "crypto.pbkdf2Sync(password, salt, iterations, keylen, digest) synchronous variant",
            "crypto.scrypt(password, salt, keylen[, options], callback) derives key",
            "crypto.scryptSync(password, salt, keylen[, options]) synchronous variant",
            "Host-side implementation uses node:crypto",
            "Test: pbkdf2Sync output matches Node.js for known inputs",
            "Test: scryptSync output matches Node.js for known inputs",
            "Typecheck passes",
            "Tests pass"
        ],
        "priority": 170,
        "passes": False,
        "notes": "Used by bcryptjs, passport, and auth libraries."
    },
    {
        "id": "US-171",
        "title": "Implement crypto.createCipheriv and crypto.createDecipheriv in bridge",
        "description": "As a developer, I need symmetric encryption for packages that encrypt/decrypt data.",
        "acceptanceCriteria": [
            "crypto.createCipheriv(algorithm, key, iv[, options]) returns Cipher stream",
            "crypto.createDecipheriv(algorithm, key, iv[, options]) returns Decipher stream",
            "Supported algorithms: aes-128-cbc, aes-256-cbc, aes-128-gcm, aes-256-gcm",
            "GCM mode supports getAuthTag() and setAuthTag()",
            "update(data, inputEncoding, outputEncoding) and final(outputEncoding) methods",
            "Test: encrypt then decrypt roundtrip produces original plaintext",
            "Test: AES-256-GCM auth tag verification",
            "Typecheck passes",
            "Tests pass"
        ],
        "priority": 171,
        "passes": False,
        "notes": "Used by SSH, TLS simulation, and data-at-rest encryption packages."
    },
    {
        "id": "US-172",
        "title": "Implement crypto.sign, crypto.verify, and key generation in bridge",
        "description": "As a developer, I need asymmetric signing and key generation for JWT, SSH, and TLS packages.",
        "acceptanceCriteria": [
            "crypto.sign(algorithm, data, key) returns signature Buffer",
            "crypto.verify(algorithm, data, key, signature) returns boolean",
            "crypto.generateKeyPairSync(type, options) for RSA and EC key pairs",
            "crypto.generateKeyPair(type, options, callback) async variant",
            "crypto.createPublicKey(key) and crypto.createPrivateKey(key) for KeyObject",
            "Test: generateKeyPairSync('rsa', {modulusLength: 2048}), sign, verify roundtrip",
            "Test: EC key pair generation and signing",
            "Typecheck passes",
            "Tests pass"
        ],
        "priority": 172,
        "passes": False,
        "notes": "Required for jsonwebtoken RS256/ES256, ssh2 key exchange."
    },
    {
        "id": "US-173",
        "title": "Implement crypto.subtle (Web Crypto API) in bridge",
        "description": "As a developer, I need the Web Crypto API (crypto.subtle) for packages that use the standard web cryptography interface.",
        "acceptanceCriteria": [
            "crypto.subtle.digest(algorithm, data) for SHA-1/256/384/512",
            "crypto.subtle.importKey and crypto.subtle.exportKey for raw/pkcs8/spki/jwk formats",
            "crypto.subtle.sign and crypto.subtle.verify for HMAC and RSASSA-PKCS1-v1_5",
            "crypto.subtle.encrypt and crypto.subtle.decrypt for AES-GCM and AES-CBC",
            "crypto.subtle.generateKey for AES and RSA key generation",
            "All operations delegate to host node:crypto via bridge calls",
            "Test: subtle.digest('SHA-256', data) matches createHash output",
            "Test: subtle.sign/verify roundtrip",
            "Typecheck passes",
            "Tests pass"
        ],
        "priority": 173,
        "passes": False,
        "notes": "Web Crypto is increasingly used by modern packages. Currently all subtle.* methods throw."
    },

    # Category 3: Package Testing Fixtures
    {
        "id": "US-174",
        "title": "Add ssh2 project-matrix fixture",
        "description": "As a developer, I need an ssh2 fixture to verify the SSH client library loads and initializes in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/ssh2-pass/ with package.json depending on ssh2",
            "Fixture imports ssh2, creates a Client instance, verifies the class exists and has expected methods (connect, end, exec, sftp)",
            "Fixture does NOT require a running SSH server \u2014 tests import/initialization only",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 174,
        "passes": False,
        "notes": "ssh2 exercises crypto, Buffer, streams, events, and net module paths."
    },
    {
        "id": "US-175",
        "title": "Add ssh2-sftp-client project-matrix fixture",
        "description": "As a developer, I need an ssh2-sftp-client fixture to verify the SFTP client library loads in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/ssh2-sftp-client-pass/ with package.json depending on ssh2-sftp-client",
            "Fixture imports ssh2-sftp-client, creates a Client instance, verifies class methods exist (connect, list, get, put, mkdir, rmdir)",
            "No running SFTP server required \u2014 tests import/initialization only",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 175,
        "passes": False,
        "notes": "Wraps ssh2. Tests the same subsystems plus additional fs-like APIs."
    },
    {
        "id": "US-176",
        "title": "Add pg (node-postgres) project-matrix fixture",
        "description": "As a developer, I need a pg fixture to verify the PostgreSQL client library loads and initializes in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/pg-pass/ with package.json depending on pg",
            "Fixture imports pg, creates a Pool instance with dummy config, verifies Pool and Client classes exist with expected methods",
            "No running database required \u2014 tests import/initialization and query building only",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 176,
        "passes": False,
        "notes": "pg exercises crypto (md5/scram-sha-256 auth), net/tls (TCP connection), Buffer, streams."
    },
    {
        "id": "US-177",
        "title": "Add drizzle-orm project-matrix fixture",
        "description": "As a developer, I need a drizzle-orm fixture to verify the ORM loads and can define schemas in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/drizzle-pass/ with package.json depending on drizzle-orm",
            "Fixture imports drizzle-orm, defines a simple table schema, verifies schema object structure",
            "No running database required \u2014 tests schema definition and query building only",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 177,
        "passes": False,
        "notes": "drizzle-orm exercises ESM module resolution, TypeScript-heavy module graph."
    },
    {
        "id": "US-178",
        "title": "Add axios project-matrix fixture",
        "description": "As a developer, I need an axios fixture to verify the HTTP client library works in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/axios-pass/ with package.json depending on axios",
            "Fixture imports axios, creates an instance, starts a local HTTP server, makes a GET request, prints response data",
            "Uses same real-HTTP pattern as Express/Fastify fixtures (createServer, listen, request, close)",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 178,
        "passes": False,
        "notes": "axios is the most popular HTTP client. Tests http bridge from client perspective."
    },
    {
        "id": "US-179",
        "title": "Add ws (WebSocket) project-matrix fixture",
        "description": "As a developer, I need a ws fixture to verify WebSocket client/server works in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/ws-pass/ with package.json depending on ws",
            "Fixture creates a WebSocket server, connects a client, sends/receives a message, closes",
            "Uses real server pattern with dynamic port",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 179,
        "passes": False,
        "notes": "ws exercises HTTP upgrade path, events, Buffer, streams."
    },
    {
        "id": "US-180",
        "title": "Add zod project-matrix fixture",
        "description": "As a developer, I need a zod fixture to verify the schema validation library works in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/zod-pass/ with package.json depending on zod",
            "Fixture defines schemas, validates data, prints results (success and failure cases)",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 180,
        "passes": False,
        "notes": "Pure JS library. Good baseline test for ESM module resolution."
    },
    {
        "id": "US-181",
        "title": "Add jsonwebtoken project-matrix fixture",
        "description": "As a developer, I need a jsonwebtoken fixture to verify JWT signing/verification works in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/jsonwebtoken-pass/ with package.json depending on jsonwebtoken",
            "Fixture signs a JWT with HS256, verifies it, prints payload",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 181,
        "passes": False,
        "notes": "Depends on crypto.createHmac (US-168). May need to be ordered after crypto stories."
    },
    {
        "id": "US-182",
        "title": "Add bcryptjs project-matrix fixture",
        "description": "As a developer, I need a bcryptjs fixture to verify password hashing works in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/bcryptjs-pass/ with package.json depending on bcryptjs",
            "Fixture hashes a password, verifies it, prints result",
            "Uses bcryptjs (pure JS) not bcrypt (native addon)",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 182,
        "passes": False,
        "notes": "bcryptjs is pure JS bcrypt. Tests computation-heavy pure JS workload."
    },
    {
        "id": "US-183",
        "title": "Add lodash-es project-matrix fixture",
        "description": "As a developer, I need a lodash-es fixture to verify large ESM module resolution works in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/lodash-es-pass/ with package.json depending on lodash-es",
            "Fixture imports several lodash functions (map, filter, groupBy, debounce), uses them, prints results",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 183,
        "passes": False,
        "notes": "lodash-es has hundreds of ESM modules. Tests ESM resolution at scale."
    },
    {
        "id": "US-184",
        "title": "Add chalk project-matrix fixture",
        "description": "As a developer, I need a chalk fixture to verify terminal styling works in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/chalk-pass/ with package.json depending on chalk",
            "Fixture uses chalk to format strings, prints results (ANSI codes visible in output)",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 184,
        "passes": False,
        "notes": "chalk exercises process.stdout, tty detection, ANSI escape codes."
    },
    {
        "id": "US-185",
        "title": "Add pino project-matrix fixture",
        "description": "As a developer, I need a pino fixture to verify the fast logging library works in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/pino-pass/ with package.json depending on pino",
            "Fixture creates a pino logger, logs structured messages, prints output",
            "Output matches between host Node and secure-exec (normalize timestamps if needed)",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 185,
        "passes": False,
        "notes": "pino exercises streams, worker_threads fallback, fast serialization."
    },
    {
        "id": "US-186",
        "title": "Add node-fetch project-matrix fixture",
        "description": "As a developer, I need a node-fetch fixture to verify the fetch polyfill works alongside the native fetch bridge.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/node-fetch-pass/ with package.json depending on node-fetch",
            "Fixture starts a local HTTP server, uses node-fetch to make a request, prints response",
            "Uses real-HTTP pattern with dynamic port",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 186,
        "passes": False,
        "notes": "Tests fetch polyfill compatibility with native fetch bridge."
    },
    {
        "id": "US-187",
        "title": "Add yaml project-matrix fixture",
        "description": "As a developer, I need a yaml fixture to verify YAML parsing works in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/yaml-pass/ with package.json depending on yaml",
            "Fixture parses YAML string, stringifies object, prints results",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 187,
        "passes": False,
        "notes": "Pure JS YAML parser. Good baseline test."
    },
    {
        "id": "US-188",
        "title": "Add uuid project-matrix fixture",
        "description": "As a developer, I need a uuid fixture to verify UUID generation works in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/uuid-pass/ with package.json depending on uuid",
            "Fixture generates v4 UUID, validates format, generates v5 UUID with namespace, prints results",
            "Output format validated (not exact match for random UUIDs \u2014 use regex or validate/version)",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 188,
        "passes": False,
        "notes": "uuid exercises crypto.randomUUID and crypto.getRandomValues paths."
    },
    {
        "id": "US-189",
        "title": "Add mysql2 project-matrix fixture",
        "description": "As a developer, I need a mysql2 fixture to verify the MySQL client library loads in the sandbox.",
        "acceptanceCriteria": [
            "Create packages/secure-exec/tests/projects/mysql2-pass/ with package.json depending on mysql2",
            "Fixture imports mysql2, creates a connection config object, verifies Pool and Connection classes exist",
            "No running database required \u2014 tests import/initialization only",
            "Output matches between host Node and secure-exec",
            "fixture.json configured correctly",
            "Typecheck passes",
            "Tests pass (project-matrix)"
        ],
        "priority": 189,
        "passes": False,
        "notes": "mysql2 exercises crypto (sha256_password auth), net/tls, Buffer, streams."
    },
]


def main():
    with open(PRD_PATH, "r", encoding="utf-8") as f:
        prd = json.load(f)

    existing_count = len(prd["userStories"])
    existing_ids = {s["id"] for s in prd["userStories"]}

    print(f"Existing stories: {existing_count}")
    print(f"Last existing ID: {prd['userStories'][-1]['id']}")
    print(f"Last existing priority: {prd['userStories'][-1]['priority']}")
    print()

    # Validate no duplicates
    for story in new_stories:
        if story["id"] in existing_ids:
            print(f"ERROR: {story['id']} already exists in PRD!")
            sys.exit(1)

    # Append new stories
    prd["userStories"].extend(new_stories)

    # Write back
    with open(PRD_PATH, "w", encoding="utf-8") as f:
        json.dump(prd, f, indent=2, ensure_ascii=False)
        f.write("\n")  # trailing newline

    final_count = len(prd["userStories"])
    print(f"Added {len(new_stories)} new stories (US-165 through US-189)")
    print(f"Total stories now: {final_count}")
    print()
    print("Breakdown by category:")
    print(f"  Compat Doc Updates:     US-165, US-166, US-167 (3 stories)")
    print(f"  Crypto Implementation:  US-168 through US-173 (6 stories)")
    print(f"  Package Test Fixtures:  US-174 through US-189 (16 stories)")
    print()
    print(f"Priority range: 165-189")
    print(f"All new stories have passes: false")


if __name__ == "__main__":
    main()
