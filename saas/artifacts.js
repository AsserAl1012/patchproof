import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client
} from "@aws-sdk/client-s3";

const DEFAULT_ARTIFACT_ROOT = resolve(process.cwd(), "data", "artifacts");

export function createArtifactStore(options = {}) {
  const driver =
    options.driver ||
    process.env.PATCHPROOF_ARTIFACT_DRIVER ||
    (process.env.PATCHPROOF_S3_BUCKET ? "s3" : "local");
  if (driver === "s3") return new S3ArtifactStore(options.s3);
  return new LocalArtifactStore(options.local);
}

export class LocalArtifactStore {
  constructor(options = {}) {
    this.driver = "local";
    this.root = resolve(options.root || process.env.PATCHPROOF_ARTIFACT_ROOT || DEFAULT_ARTIFACT_ROOT);
  }

  async putJson({ orgId, runId, kind, value }) {
    return this.putBytes({
      orgId,
      runId,
      kind,
      bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
      contentType: "application/json; charset=utf-8"
    });
  }

  async putText({ orgId, runId, kind, text, contentType = "text/plain; charset=utf-8" }) {
    return this.putBytes({ orgId, runId, kind, bytes: Buffer.from(String(text || ""), "utf8"), contentType });
  }

  async putBytes({ orgId, runId, kind, bytes, contentType = "application/octet-stream" }) {
    const body = Buffer.from(bytes || "");
    const hash = sha256(body);
    const key = artifactKey({ orgId, runId, kind, hash });
    const path = resolve(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return { storageDriver: this.driver, storageKey: key, sha256: hash, bytes: body.length, contentType };
  }

  async getBytes({ storageKey, sha256: expectedHash = "" }) {
    const body = await readFile(resolve(this.root, storageKey));
    verifyHash(body, expectedHash);
    return body;
  }

  async getJson(artifact) {
    const body = await this.getBytes(artifact);
    return JSON.parse(body.toString("utf8"));
  }

  async health() {
    await mkdir(this.root, { recursive: true });
    return { ok: true, driver: this.driver };
  }
}

export class S3ArtifactStore {
  constructor(options = {}) {
    this.driver = "s3";
    this.bucket = options.bucket || process.env.PATCHPROOF_S3_BUCKET || "patchproof";
    this.client = new S3Client({
      region: options.region || process.env.PATCHPROOF_S3_REGION || "us-east-1",
      endpoint: options.endpoint || process.env.PATCHPROOF_S3_ENDPOINT || undefined,
      forcePathStyle: String(options.forcePathStyle ?? process.env.PATCHPROOF_S3_FORCE_PATH_STYLE ?? "true") === "true",
      credentials:
        options.accessKeyId || process.env.PATCHPROOF_S3_ACCESS_KEY_ID
          ? {
              accessKeyId: options.accessKeyId || process.env.PATCHPROOF_S3_ACCESS_KEY_ID,
              secretAccessKey: options.secretAccessKey || process.env.PATCHPROOF_S3_SECRET_ACCESS_KEY
            }
          : undefined
    });
  }

  async putJson({ orgId, runId, kind, value }) {
    return this.putBytes({
      orgId,
      runId,
      kind,
      bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
      contentType: "application/json; charset=utf-8"
    });
  }

  async putText({ orgId, runId, kind, text, contentType = "text/plain; charset=utf-8" }) {
    return this.putBytes({ orgId, runId, kind, bytes: Buffer.from(String(text || ""), "utf8"), contentType });
  }

  async putBytes({ orgId, runId, kind, bytes, contentType = "application/octet-stream" }) {
    const body = Buffer.from(bytes || "");
    const hash = sha256(body);
    const key = artifactKey({ orgId, runId, kind, hash });
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        Metadata: { sha256: hash }
      })
    );
    return { storageDriver: this.driver, storageKey: key, sha256: hash, bytes: body.length, contentType };
  }

  async getBytes({ storageKey, sha256: expectedHash = "" }) {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    const body = Buffer.from(await response.Body.transformToByteArray());
    verifyHash(body, expectedHash);
    return body;
  }

  async getJson(artifact) {
    const body = await this.getBytes(artifact);
    return JSON.parse(body.toString("utf8"));
  }

  async health() {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return { ok: true, driver: this.driver, bucket: this.bucket };
  }
}

export function artifactKey({ orgId, runId, kind, hash }) {
  const safeKind = String(kind || "artifact").replace(/[^a-z0-9_.-]/gi, "-").toLowerCase();
  return `${orgId || "org"}/${runId || randomBytes(8).toString("hex")}/${safeKind}-${hash.slice(0, 16)}.json`;
}

export function verifyHash(bytes, expectedHash) {
  if (!expectedHash) return true;
  const actual = sha256(bytes);
  if (actual !== expectedHash) {
    const error = new Error("Artifact hash verification failed.");
    error.statusCode = 409;
    throw error;
  }
  return true;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
