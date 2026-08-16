// Minimal AWS Signature Version 4 signer using the Web Crypto API.
// Works in Cloudflare Workers with zero external dependencies.
//
// Reference:
// https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignInput {
  method: string;
  url: string; // full URL including protocol, host, path and query
  service: string; // e.g. "s3", "ec2", "sts"
  region: string; // e.g. "us-east-1"
  headers?: Record<string, string>;
  body?: string; // request body (already serialized)
  credentials: AwsCredentials;
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return toHex(digest);
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

// RFC 3986 encoding used by AWS. When encodeSlash is false, "/" is left as-is
// (used for the canonical URI path).
function awsUriEncode(input: string, encodeSlash = true): string {
  let out = "";
  for (const ch of input) {
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === "/" && !encodeSlash) {
      out += "/";
    } else {
      for (const b of encoder.encode(ch)) {
        out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return out;
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  // iso like 20240901T120000Z
  const amzDate = iso;
  const dateStamp = amzDate.slice(0, 8);
  return { amzDate, dateStamp };
}

/**
 * Sign a request and return the headers to send (including Authorization).
 */
export async function signRequest(input: SignInput): Promise<Record<string, string>> {
  const { method, service, region, body = "", credentials } = input;
  const url = new URL(input.url);
  const { amzDate, dateStamp } = amzDates(new Date());

  const payloadHash = await sha256Hex(body);

  // Build headers (lowercase keys for canonicalization).
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    headers[k.toLowerCase().trim()] = String(v).trim();
  }
  headers["host"] = url.host;
  headers["x-amz-date"] = amzDate;
  headers["x-amz-content-sha256"] = payloadHash;
  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }

  // Canonical URI (path).
  const canonicalUri = awsUriEncode(url.pathname || "/", false);

  // Canonical query string (sorted by encoded key).
  const params: [string, string][] = [];
  url.searchParams.forEach((value, key) => params.push([key, value]));
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const canonicalQuery = params
    .map(([k, v]) => `${awsUriEncode(k)}=${awsUriEncode(v)}`)
    .join("&");

  // Canonical headers + signed headers.
  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  // Derive signing key.
  const kDate = await hmac(encoder.encode("AWS4" + credentials.secretAccessKey), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signature = toHex(await hmac(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // Return the final set of headers to send on the wire (original case for the
  // few we forced lowercase doesn't matter — HTTP headers are case-insensitive).
  const outHeaders: Record<string, string> = { ...headers };
  outHeaders["Authorization"] = authorization;
  return outHeaders;
}
