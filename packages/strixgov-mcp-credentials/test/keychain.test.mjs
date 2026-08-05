/**
 * @strixgov/mcp-credentials — unit tests.
 *
 * These tests run without a live OS keychain or a real keytar installation,
 * so they focus on:
 *   1. The "keychain unavailable" code path (most CI environments).
 *   2. The resolver with env-var–sourced credentials (no keytar required).
 *   3. Error class structure and validation logic.
 *
 * For end-to-end keychain tests, run against a machine with keytar installed
 * and a supported keychain backend (macOS Keychain, Windows Credential Manager,
 * or GNOME Keyring / KWallet on Linux).
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  isKeychainAvailable,
  setCredential,
  getCredential,
  removeCredential,
  listCredentials,
  KeychainUnavailableError,
  KeychainPermissionError,
} from "../src/keychain.mjs";
import {
  resolveUpstreamCredentials,
  CredentialNotFoundError,
} from "../src/resolver.mjs";

// ─── 1. Error class shapes ────────────────────────────────────────────────────

describe("KeychainUnavailableError", () => {
  test("has correct name and code", () => {
    const err = new KeychainUnavailableError("test reason");
    assert.equal(err.name, "KeychainUnavailableError");
    assert.equal(err.code, "KEYCHAIN_UNAVAILABLE");
    assert(err instanceof Error);
    assert(err.message.includes("OS keychain is unavailable"));
    assert(err.message.includes("test reason"));
  });
});

describe("KeychainPermissionError", () => {
  test("has correct name and code", () => {
    const cause = new Error("OS denied");
    const err = new KeychainPermissionError("notion.token", cause);
    assert.equal(err.name, "KeychainPermissionError");
    assert.equal(err.code, "KEYCHAIN_PERMISSION_DENIED");
    assert(err instanceof Error);
    assert(err.message.includes("notion.token"));
    assert(err.message.includes("OS denied"));
  });

  test("handles missing cause", () => {
    const err = new KeychainPermissionError("some.key");
    assert(err.message.includes("some.key"));
  });
});

describe("CredentialNotFoundError", () => {
  test("keychain spec — message and properties", () => {
    const spec = { from: "keychain", key: "notion.token" };
    const err = new CredentialNotFoundError("NOTION_API_KEY", spec);
    assert.equal(err.name, "CredentialNotFoundError");
    assert.equal(err.code, "CREDENTIAL_NOT_FOUND");
    assert.equal(err.envKey, "NOTION_API_KEY");
    assert.equal(err.spec, spec);
    assert(err.message.includes("NOTION_API_KEY"));
    assert(err.message.includes("notion.token"));
    assert(err.message.includes("strix-mcp-credentials set"));
  });

  test("env spec — message includes env key", () => {
    const spec = { from: "env", key: "NOTION_API_KEY" };
    const err = new CredentialNotFoundError("NOTION_API_KEY", spec);
    assert(err.message.includes("NOTION_API_KEY"));
  });
});

// ─── 2. isKeychainAvailable ───────────────────────────────────────────────────

describe("isKeychainAvailable", () => {
  test("returns a boolean", async () => {
    const result = await isKeychainAvailable();
    assert(typeof result === "boolean");
  });
});

// ─── 3. Keychain operations when keytar is absent ─────────────────────────────
//
// These tests are conditional: they assert the "unavailable" path only when
// keytar is actually absent in the test environment.  On a developer machine
// with keytar installed the tests skip rather than break.

describe("keychain operations (keytar absent)", async () => {
  const available = await isKeychainAvailable();

  if (available) {
    test("keytar is present — unavailability tests skipped", () => {
      // Nothing to assert; the conditional tests below are skipped.
    });
  } else {
    test("setCredential throws KeychainUnavailableError", async () => {
      await assert.rejects(
        () => setCredential("test.key", "value"),
        (err) => {
          assert(err instanceof KeychainUnavailableError, "expected KeychainUnavailableError");
          return true;
        },
      );
    });

    test("getCredential throws KeychainUnavailableError", async () => {
      await assert.rejects(
        () => getCredential("test.key"),
        (err) => {
          assert(err instanceof KeychainUnavailableError);
          return true;
        },
      );
    });

    test("removeCredential throws KeychainUnavailableError", async () => {
      await assert.rejects(
        () => removeCredential("test.key"),
        (err) => {
          assert(err instanceof KeychainUnavailableError);
          return true;
        },
      );
    });

    test("listCredentials throws KeychainUnavailableError", async () => {
      await assert.rejects(
        () => listCredentials(),
        (err) => {
          assert(err instanceof KeychainUnavailableError);
          return true;
        },
      );
    });
  }
});

// ─── 4. resolveUpstreamCredentials — env-var sourced (no keytar needed) ───────

describe("resolveUpstreamCredentials — env specs", () => {
  const SAVED = {};

  before(() => {
    SAVED.STRIX_TEST_TOKEN = process.env.STRIX_TEST_TOKEN;
    SAVED.STRIX_TEST_TOKEN_2 = process.env.STRIX_TEST_TOKEN_2;
    process.env.STRIX_TEST_TOKEN = "env-value-abc";
    process.env.STRIX_TEST_TOKEN_2 = "env-value-xyz";
  });

  after(() => {
    if (SAVED.STRIX_TEST_TOKEN === undefined) {
      delete process.env.STRIX_TEST_TOKEN;
    } else {
      process.env.STRIX_TEST_TOKEN = SAVED.STRIX_TEST_TOKEN;
    }
    if (SAVED.STRIX_TEST_TOKEN_2 === undefined) {
      delete process.env.STRIX_TEST_TOKEN_2;
    } else {
      process.env.STRIX_TEST_TOKEN_2 = SAVED.STRIX_TEST_TOKEN_2;
    }
  });

  test("returns empty object for null or undefined input", async () => {
    assert.deepEqual(await resolveUpstreamCredentials(null), {});
    assert.deepEqual(await resolveUpstreamCredentials(undefined), {});
    assert.deepEqual(await resolveUpstreamCredentials({}), {});
  });

  test("resolves from env", async () => {
    const result = await resolveUpstreamCredentials({
      MY_TOKEN: { from: "env", key: "STRIX_TEST_TOKEN" },
    });
    assert.deepEqual(result, { MY_TOKEN: "env-value-abc" });
  });

  test("resolves multiple env keys", async () => {
    const result = await resolveUpstreamCredentials({
      TOKEN_A: { from: "env", key: "STRIX_TEST_TOKEN" },
      TOKEN_B: { from: "env", key: "STRIX_TEST_TOKEN_2" },
    });
    assert.deepEqual(result, {
      TOKEN_A: "env-value-abc",
      TOKEN_B: "env-value-xyz",
    });
  });

  test("throws CredentialNotFoundError when required env key is absent", async () => {
    delete process.env.STRIX_TEST_MISSING;
    await assert.rejects(
      () =>
        resolveUpstreamCredentials({
          MISSING_TOKEN: { from: "env", key: "STRIX_TEST_MISSING" },
        }),
      (err) => {
        assert(err instanceof CredentialNotFoundError, "expected CredentialNotFoundError");
        assert.equal(err.envKey, "MISSING_TOKEN");
        assert.equal(err.spec.key, "STRIX_TEST_MISSING");
        return true;
      },
    );
  });

  test("omits optional credential when env key is absent", async () => {
    delete process.env.STRIX_TEST_OPTIONAL;
    const result = await resolveUpstreamCredentials({
      PRESENT: { from: "env", key: "STRIX_TEST_TOKEN" },
      OPTIONAL: { from: "env", key: "STRIX_TEST_OPTIONAL", optional: true },
    });
    assert.deepEqual(result, { PRESENT: "env-value-abc" });
    assert(!("OPTIONAL" in result));
  });
});

// ─── 5. resolveUpstreamCredentials — input validation ────────────────────────

describe("resolveUpstreamCredentials — validation", () => {
  test("throws TypeError for non-object spec", async () => {
    await assert.rejects(
      () => resolveUpstreamCredentials({ MY_TOKEN: "not-an-object" }),
      TypeError,
    );
  });

  test("throws TypeError for unknown 'from' value", async () => {
    await assert.rejects(
      () =>
        resolveUpstreamCredentials({
          MY_TOKEN: { from: "vault", key: "some.key" },
        }),
      TypeError,
    );
  });

  test("throws TypeError for missing 'key'", async () => {
    await assert.rejects(
      () =>
        resolveUpstreamCredentials({
          MY_TOKEN: { from: "env" },
        }),
      TypeError,
    );
  });

  test("throws TypeError for empty 'key'", async () => {
    await assert.rejects(
      () =>
        resolveUpstreamCredentials({
          MY_TOKEN: { from: "env", key: "" },
        }),
      TypeError,
    );
  });
});

// ─── 6. resolveUpstreamCredentials — keychain fallback path when unavailable ──

describe("resolveUpstreamCredentials — keychain fallback", async () => {
  const available = await isKeychainAvailable();

  if (!available) {
    test("keychain spec with env fallback uses env when keychain is unavailable", async () => {
      const saved = process.env.MY_FALLBACK_VAR;
      process.env.MY_FALLBACK_VAR = "fallback-value";
      try {
        const result = await resolveUpstreamCredentials({
          MY_FALLBACK_VAR: { from: "keychain", key: "test.key" },
        });
        assert.deepEqual(result, { MY_FALLBACK_VAR: "fallback-value" });
      } finally {
        if (saved === undefined) delete process.env.MY_FALLBACK_VAR;
        else process.env.MY_FALLBACK_VAR = saved;
      }
    });

    test("keychain spec throws KeychainUnavailableError when env fallback also absent", async () => {
      delete process.env.STRIX_CRED_NO_ENV_FALLBACK;
      await assert.rejects(
        () =>
          resolveUpstreamCredentials({
            STRIX_CRED_NO_ENV_FALLBACK: { from: "keychain", key: "test.key" },
          }),
        (err) => {
          assert(err instanceof KeychainUnavailableError, "expected KeychainUnavailableError");
          return true;
        },
      );
    });

    test("optional keychain spec returns empty object when keychain unavailable and no env fallback", async () => {
      delete process.env.STRIX_CRED_OPTIONAL_NO_ENV;
      const result = await resolveUpstreamCredentials({
        STRIX_CRED_OPTIONAL_NO_ENV: { from: "keychain", key: "test.key", optional: true },
      });
      assert.deepEqual(result, {});
    });
  }
});
