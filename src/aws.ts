// AWS request execution + MCP tool definitions.
import { signRequest, type AwsCredentials } from "./sigv4";

export interface Env {
  MCP_AUTH_TOKEN?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SESSION_TOKEN?: string;
  AWS_DEFAULT_REGION?: string;
}

function credentials(env: Env): AwsCredentials {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error(
      "Missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as Worker secrets.",
    );
  }
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
  };
}

// Global (non-regional) services keep a fixed signing region / host.
function defaultHost(service: string, region: string): { host: string; signRegion: string } {
  switch (service) {
    case "iam":
      return { host: "iam.amazonaws.com", signRegion: "us-east-1" };
    case "route53":
      return { host: "route53.amazonaws.com", signRegion: "us-east-1" };
    case "cloudfront":
      return { host: "cloudfront.amazonaws.com", signRegion: "us-east-1" };
    case "s3":
      return { host: `s3.${region}.amazonaws.com`, signRegion: region };
    default:
      return { host: `${service}.${region}.amazonaws.com`, signRegion: region };
  }
}

export interface AwsRequestOptions {
  service: string;
  region?: string;
  method?: string;
  host?: string;
  path?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
}

export interface AwsResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export async function awsRequest(env: Env, opts: AwsRequestOptions): Promise<AwsResponse> {
  const region = opts.region || env.AWS_DEFAULT_REGION || "us-east-1";
  const service = opts.service;
  const derived = defaultHost(service, region);
  const host = opts.host || derived.host;
  const signRegion = opts.host ? region : derived.signRegion;
  const method = (opts.method || "POST").toUpperCase();
  const path = opts.path || "/";

  const url = new URL(`https://${host}${path.startsWith("/") ? path : "/" + path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    url.searchParams.set(k, v);
  }

  const body = opts.body ?? "";
  const signed = await signRequest({
    method,
    url: url.toString(),
    service,
    region: signRegion,
    headers: opts.headers,
    body,
    credentials: credentials(env),
  });

  const res = await fetch(url.toString(), {
    method,
    headers: signed,
    body: method === "GET" || method === "HEAD" ? undefined : body || undefined,
  });

  const text = await res.text();
  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => (outHeaders[k] = v));
  return {
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
    body: text,
  };
}

// Query-protocol helper (EC2, STS, IAM, ...): builds an
// application/x-www-form-urlencoded body from Action/Version/params.
async function queryApi(
  env: Env,
  service: string,
  action: string,
  version: string,
  params: Record<string, string> = {},
  region?: string,
): Promise<AwsResponse> {
  const form = new URLSearchParams();
  form.set("Action", action);
  form.set("Version", version);
  for (const [k, v] of Object.entries(params)) form.set(k, v);
  return awsRequest(env, {
    service,
    region,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
    body: form.toString(),
  });
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (env: Env, args: Record<string, any>) => Promise<AwsResponse>;
}

export const TOOLS: McpTool[] = [
  {
    name: "aws_api_request",
    description:
      "Execute ANY AWS API call by sending a raw, SigV4-signed HTTPS request. This is the general-purpose escape hatch: choose the service, region, HTTP method, path, query params, headers and body according to the AWS API for that service. Returns the raw HTTP status and body (usually XML or JSON). Examples: STS/EC2/IAM use the Query protocol (POST, content-type application/x-www-form-urlencoded, body 'Action=...&Version=...'); Lambda/DynamoDB use REST-JSON; S3 uses REST-XML.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "AWS service code, e.g. 's3', 'ec2', 'sts', 'lambda', 'iam', 'dynamodb'." },
        region: { type: "string", description: "AWS region, e.g. 'us-east-1'. Defaults to the server's AWS_DEFAULT_REGION." },
        method: { type: "string", description: "HTTP method (GET, POST, PUT, DELETE...). Defaults to POST." },
        host: { type: "string", description: "Optional explicit host override, e.g. 'my-bucket.s3.us-east-1.amazonaws.com'. If omitted it is derived from service+region." },
        path: { type: "string", description: "Request path, defaults to '/'." },
        query: { type: "object", description: "Query string parameters as a key/value object." },
        headers: { type: "object", description: "Extra HTTP headers as a key/value object (e.g. content-type, x-amz-target for JSON APIs)." },
        body: { type: "string", description: "Raw request body string (form-encoded for Query APIs, JSON for JSON APIs, etc.)." },
      },
      required: ["service"],
    },
    handler: (env, a) => awsRequest(env, a as AwsRequestOptions),
  },
  {
    name: "sts_get_caller_identity",
    description: "Return details about the IAM identity of the configured credentials (account, ARN, user id). Great first call to verify the server is wired up correctly.",
    inputSchema: { type: "object", properties: { region: { type: "string" } } },
    handler: (env, a) => queryApi(env, "sts", "GetCallerIdentity", "2011-06-15", {}, a.region),
  },
  {
    name: "s3_list_buckets",
    description: "List all S3 buckets in the account.",
    inputSchema: { type: "object", properties: { region: { type: "string" } } },
    handler: (env, a) =>
      awsRequest(env, { service: "s3", region: a.region, method: "GET", path: "/" }),
  },
  {
    name: "s3_list_objects",
    description: "List objects in an S3 bucket (ListObjectsV2). Supports optional prefix.",
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string", description: "Bucket name." },
        prefix: { type: "string", description: "Optional key prefix filter." },
        region: { type: "string", description: "Bucket region. Defaults to server default region." },
        maxKeys: { type: "number", description: "Max keys to return (default 100)." },
      },
      required: ["bucket"],
    },
    handler: (env, a) => {
      const region = a.region || env.AWS_DEFAULT_REGION || "us-east-1";
      const query: Record<string, string> = { "list-type": "2", "max-keys": String(a.maxKeys ?? 100) };
      if (a.prefix) query["prefix"] = a.prefix;
      return awsRequest(env, {
        service: "s3",
        region,
        method: "GET",
        host: `${a.bucket}.s3.${region}.amazonaws.com`,
        path: "/",
        query,
      });
    },
  },
  {
    name: "ec2_describe_instances",
    description: "Describe EC2 instances in a region.",
    inputSchema: { type: "object", properties: { region: { type: "string" } } },
    handler: (env, a) => queryApi(env, "ec2", "DescribeInstances", "2016-11-15", {}, a.region),
  },
  {
    name: "ec2_describe_regions",
    description: "List all EC2 regions available to the account.",
    inputSchema: { type: "object", properties: { region: { type: "string" } } },
    handler: (env, a) => queryApi(env, "ec2", "DescribeRegions", "2016-11-15", {}, a.region),
  },
  {
    name: "iam_list_users",
    description: "List IAM users in the account.",
    inputSchema: { type: "object", properties: {} },
    handler: (env) => queryApi(env, "iam", "ListUsers", "2010-05-08", {}, "us-east-1"),
  },
  {
    name: "lambda_list_functions",
    description: "List Lambda functions in a region.",
    inputSchema: { type: "object", properties: { region: { type: "string" } } },
    handler: (env, a) =>
      awsRequest(env, {
        service: "lambda",
        region: a.region,
        method: "GET",
        path: "/2015-03-31/functions/",
      }),
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
