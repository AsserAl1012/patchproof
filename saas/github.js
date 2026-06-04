import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGitHubSignature({ secret, body, signature256 }) {
  if (!secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const left = Buffer.from(expected);
  const right = Buffer.from(signature256 || "");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function parsePatchProofCommand(text = "") {
  const match = String(text).match(/\/patchproof\s+(verify|fix|explain)\b/i);
  return match ? match[1].toLowerCase() : null;
}
