# IAM policies for aws-mcp

The credentials you give the Worker can do **anything those keys are allowed to
do** — the `aws_api_request` tool is a general escape hatch. So the safest setup
is a **dedicated IAM user** with the **least privilege** you actually need, not
your root or admin keys.

Pick one of the policies below based on how you intend to use the server.

## Option A — `least-privilege.json` (recommended default)

Grants exactly what the **built-in convenience tools** need and nothing else:

| Tool | Permission |
|------|-----------|
| `sts_get_caller_identity` | `sts:GetCallerIdentity` |
| `s3_list_buckets` | `s3:ListAllMyBuckets`, `s3:GetBucketLocation` |
| `s3_list_objects` | `s3:ListBucket` |
| `ec2_describe_instances`, `ec2_describe_regions` | `ec2:Describe*` (scoped) |
| `lambda_list_functions` | `lambda:ListFunctions` |
| `iam_list_users` | `iam:ListUsers` |

With this policy the generic `aws_api_request` tool only works for these same
read actions; anything else returns AccessDenied — which is the point.

## Option B — broad read-only (explore everything, change nothing)

If you want the generic tool to inspect any service but never modify anything,
attach the AWS **managed** policy instead of an inline one:

```
arn:aws:iam::aws:policy/ReadOnlyAccess
```

## Option C — write access

Only if you genuinely need the server to create/modify/delete resources. Do NOT
use admin keys blindly; scope actions and resources to what you need (e.g. a
single S3 bucket, a specific Lambda). Add statements to `least-privilege.json`
like:

```json
{
  "Sid": "McpS3WriteOneBucket",
  "Effect": "Allow",
  "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
  "Resource": "arn:aws:s3:::my-bucket/*"
}
```

## Create a dedicated user and get keys

Using the AWS CLI on your own machine (with an admin profile):

```bash
# 1. create a user just for the MCP server
aws iam create-user --user-name aws-mcp-worker

# 2. attach the least-privilege policy from this repo
aws iam put-user-policy \
  --user-name aws-mcp-worker \
  --policy-name aws-mcp-least-privilege \
  --policy-document file://policies/least-privilege.json

#    (or, for Option B, attach the managed read-only policy instead)
# aws iam attach-user-policy \
#   --user-name aws-mcp-worker \
#   --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess

# 3. create access keys — copy the output into the Worker secrets
aws iam create-access-key --user-name aws-mcp-worker
```

Then set them on the Worker:

```bash
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

## Even safer: temporary credentials

Instead of long-lived keys you can issue short-lived STS credentials and set all
three secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`).
They expire automatically — rotate them before they lapse.

```bash
aws sts get-session-token --duration-seconds 3600
```

## Tips

- Enable CloudTrail so every call the server makes is logged.
- Keep the Worker's `MCP_AUTH_TOKEN` set — it's what stops the public internet
  from using these keys.
- Rotate keys periodically (`aws iam create-access-key` + delete the old one).
