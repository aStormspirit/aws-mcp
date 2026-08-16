# aws-mcp

A remote **MCP (Model Context Protocol) server** that runs on **Cloudflare Workers**
and lets an MCP client (like Claude) execute **AWS commands with your own credentials**.

## How it works (and an important note about the "AWS CLI")

Cloudflare Workers run in a lightweight V8 isolate — there is **no filesystem,
no subprocesses, and no Python**, so the real `aws` CLI binary cannot run there.
Instead, this Worker talks to AWS the same way the CLI does under the hood: it
builds **SigV4-signed HTTPS requests** to the AWS service APIs. The result is the
same capability — "give it keys and run AWS commands" — implemented in a way that
actually runs on Cloudflare, with **zero runtime dependencies** (SigV4 is
hand-rolled with the Web Crypto API).

The MCP client (Claude) knows the AWS APIs, so it can drive the generic
`aws_api_request` tool to perform essentially any operation, plus there are
ready-made convenience tools for common tasks.

## Tools exposed

| Tool | What it does |
|------|--------------|
| `aws_api_request` | **Escape hatch** — run ANY AWS API call (choose service, region, method, path, query, headers, body). Returns raw HTTP status + body. |
| `sts_get_caller_identity` | Who am I? Verifies the credentials are wired up. |
| `s3_list_buckets` | List all S3 buckets. |
| `s3_list_objects` | List objects in a bucket (optional prefix). |
| `ec2_describe_instances` | Describe EC2 instances in a region. |
| `ec2_describe_regions` | List available regions. |
| `iam_list_users` | List IAM users. |
| `lambda_list_functions` | List Lambda functions. |

## Deploy to Cloudflare (via the GitHub form you have open)

The repo is already set up for Cloudflare's "Import a repository" flow:

- **Build command:** *(leave empty)*
- **Deploy command:** `npx wrangler deploy`

Click **Deploy**. Cloudflare installs dependencies and runs Wrangler, which reads
`wrangler.toml` and publishes the Worker named `aws-mcp`.

### After the first deploy — add your secrets

The Worker needs credentials. Set them **as secrets** (never commit them). Either
in the dashboard (**Workers & Pages → aws-mcp → Settings → Variables and Secrets →
Add → Encrypt**) or from a terminal:

```bash
npx wrangler secret put MCP_AUTH_TOKEN         # a long random string YOU invent
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
# optional, only for temporary/STS credentials:
npx wrangler secret put AWS_SESSION_TOKEN
```

The default region lives in `wrangler.toml` (`AWS_DEFAULT_REGION`); override per
call with a `region` argument.

> **Security:** `MCP_AUTH_TOKEN` is what stops the public internet from using your
> AWS keys. Always set it. Give AWS keys the **least privilege** you need — this
> server can do whatever those keys can do.

## Connect an MCP client

Add the Worker URL (e.g. `https://aws-mcp.<your-subdomain>.workers.dev`) as a
**Streamable HTTP** MCP server, sending your token:

```
Authorization: Bearer <MCP_AUTH_TOKEN>
```

For Claude Code / CLI:

```bash
claude mcp add --transport http aws https://aws-mcp.<your-subdomain>.workers.dev \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

Clients that can't set headers may instead append `?token=<MCP_AUTH_TOKEN>` to the URL.

## Quick checks

```bash
# health (no auth needed)
curl https://aws-mcp.<your-subdomain>.workers.dev/health

# list tools
curl -X POST https://aws-mcp.<your-subdomain>.workers.dev \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# who am I
curl -X POST https://aws-mcp.<your-subdomain>.workers.dev \
  -H "Authorization: Bearer <MCP_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sts_get_caller_identity","arguments":{}}}'
```

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars   # fill in your keys
npm run dev
```

## Layout

```
src/index.ts   MCP JSON-RPC over HTTP (Streamable HTTP transport) + routing/auth
src/aws.ts     AWS request execution + tool definitions
src/sigv4.ts   AWS Signature V4 signer (Web Crypto, no dependencies)
wrangler.toml  Cloudflare Worker config
```
