import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const SECRET_MARKER = "__patchproofSecret";
const SECRET_PATHS = [
  ["modelProvider", "apiKey"],
  ["github", "privateKey"],
  ["github", "webhookSecret"],
  ["github", "token"]
];

export function encryptSettingsSecrets(settings) {
  const clone = structuredClone(settings || {});
  for (const path of SECRET_PATHS) {
    const value = getPath(clone, path);
    if (typeof value === "string" && value) setPath(clone, path, encryptSecret(value));
  }
  return clone;
}

export function decryptSettingsSecrets(settings) {
  const clone = structuredClone(settings || {});
  for (const path of SECRET_PATHS) {
    const value = getPath(clone, path);
    if (isEncryptedSecret(value)) setPath(clone, path, decryptSecret(value));
  }
  return clone;
}

export function maskSettingsSecrets(settings) {
  const clone = structuredClone(settings || {});
  for (const path of SECRET_PATHS) {
    const value = getPath(clone, path);
    if (typeof value === "string" && value) setPath(clone, path, "********");
    if (isEncryptedSecret(value)) setPath(clone, path, "********");
  }
  return clone;
}

export function assertProductionSecretConfiguration() {
  if (process.env.NODE_ENV !== "production") return;
  const value = String(process.env.PATCHPROOF_SECRET_KEY || "");
  if (!value || value === "replace-with-random-32-byte-secret" || value.length < 32) {
    throw new Error(
      "PATCHPROOF_SECRET_KEY must be set to at least 32 non-placeholder characters in production."
    );
  }
}

export function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    [SECRET_MARKER]: true,
    value: Buffer.concat([iv, tag, ciphertext]).toString("base64")
  };
}

export function decryptSecret(value) {
  const bytes = Buffer.from(value.value, "base64");
  const iv = bytes.subarray(0, 12);
  const tag = bytes.subarray(12, 28);
  const ciphertext = bytes.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function secretKey() {
  assertProductionSecretConfiguration();
  return createHash("sha256").update(process.env.PATCHPROOF_SECRET_KEY || "patchproof-development-secret-key").digest();
}

function isEncryptedSecret(value) {
  return Boolean(value && typeof value === "object" && value[SECRET_MARKER] === true && value.value);
}

function getPath(object, path) {
  return path.reduce((cursor, key) => (cursor ? cursor[key] : undefined), object);
}

function setPath(object, path, value) {
  let cursor = object;
  for (const key of path.slice(0, -1)) {
    cursor[key] ||= {};
    cursor = cursor[key];
  }
  cursor[path.at(-1)] = value;
}
