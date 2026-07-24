/**
 * One-time / re-runnable bucket hardening for the S3 bucket backing PerfStudio's
 * zero-local-disk storage (see PROJECT_MAP.md "S3 migration").
 *
 * Applies (idempotently — safe to re-run, each call simply overwrites the desired state):
 *   - Default server-side encryption: SSE-KMS (falls back to the AWS-managed `aws/s3`
 *     key if S3_KMS_KEY_ID isn't set — set it to use a customer-managed CMK instead)
 *   - Versioning: enabled (protects against accidental/malicious overwrite or delete)
 *   - Lifecycle policy: expires noncurrent versions after N days, aborts incomplete
 *     multipart uploads after N days (cost hygiene, doesn't affect current-version data)
 *
 * Deliberately NOT run automatically at app boot — these are bucket-admin-level actions
 * (s3:PutBucketEncryption/PutBucketVersioning/PutBucketLifecycleConfiguration) that the
 * running app should never hold. Run this manually or from a deploy pipeline using
 * separate, elevated credentials; see iam-policy-runtime.json for the policy the app
 * itself should run with day-to-day.
 *
 * Usage:
 *   node backend/scripts/provisionS3Bucket.js
 *
 * Required env: S3_BUCKET, S3_REGION (or set via AWS_PROFILE/AWS_REGION + credentials
 * from the standard AWS credential chain — this script does not read S3_ACCESS_KEY_ID/
 * S3_SECRET_ACCESS_KEY on purpose, so the app's own restricted runtime keys can't
 * accidentally be reused for a bucket-admin operation. Use `aws configure` / an
 * assumed elevated role / AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY env vars instead).
 * Optional env: S3_KMS_KEY_ID, S3_LIFECYCLE_NONCURRENT_EXPIRE_DAYS (default 90),
 * S3_LIFECYCLE_ABORT_INCOMPLETE_UPLOAD_DAYS (default 7), S3_ENDPOINT (MinIO/other).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const {
  S3Client,
  PutBucketEncryptionCommand,
  PutBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
} = require('@aws-sdk/client-s3');

const BUCKET = process.env.S3_BUCKET;
const KMS_KEY_ID = process.env.S3_KMS_KEY_ID; // undefined => AWS-managed aws/s3 key
const NONCURRENT_EXPIRE_DAYS = Number(process.env.S3_LIFECYCLE_NONCURRENT_EXPIRE_DAYS) || 90;
const ABORT_INCOMPLETE_UPLOAD_DAYS = Number(process.env.S3_LIFECYCLE_ABORT_INCOMPLETE_UPLOAD_DAYS) || 7;

function requireEnv() {
  if (!BUCKET) {
    console.error('S3_BUCKET is required.');
    process.exit(1);
  }
}

function client() {
  return new S3Client({
    region: process.env.S3_REGION,
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: !!process.env.S3_ENDPOINT,
  });
}

async function applyEncryption(s3) {
  const rule = KMS_KEY_ID
    ? { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KMS_KEY_ID }, BucketKeyEnabled: true }
    : { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' }, BucketKeyEnabled: true };
  await s3.send(new PutBucketEncryptionCommand({
    Bucket: BUCKET,
    ServerSideEncryptionConfiguration: { Rules: [rule] },
  }));
  const check = await s3.send(new GetBucketEncryptionCommand({ Bucket: BUCKET }));
  console.log(`✓ Default encryption: ${check.ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm}`
    + (KMS_KEY_ID ? ` (key: ${KMS_KEY_ID})` : ' (AWS-managed aws/s3 key)'));
}

async function applyVersioning(s3) {
  await s3.send(new PutBucketVersioningCommand({
    Bucket: BUCKET,
    VersioningConfiguration: { Status: 'Enabled' },
  }));
  const check = await s3.send(new GetBucketVersioningCommand({ Bucket: BUCKET }));
  console.log(`✓ Versioning: ${check.Status}`);
}

async function applyLifecycle(s3) {
  await s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: BUCKET,
    LifecycleConfiguration: {
      Rules: [
        {
          ID: 'expire-noncurrent-versions',
          Status: 'Enabled',
          Filter: {},
          NoncurrentVersionExpiration: { NoncurrentDays: NONCURRENT_EXPIRE_DAYS },
        },
        {
          ID: 'abort-incomplete-multipart-uploads',
          Status: 'Enabled',
          Filter: {},
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: ABORT_INCOMPLETE_UPLOAD_DAYS },
        },
      ],
    },
  }));
  console.log(`✓ Lifecycle policy: noncurrent versions expire after ${NONCURRENT_EXPIRE_DAYS}d, `
    + `incomplete multipart uploads aborted after ${ABORT_INCOMPLETE_UPLOAD_DAYS}d`);
}

async function main() {
  requireEnv();
  const s3 = client();
  console.log(`Provisioning bucket "${BUCKET}"...`);
  await applyEncryption(s3);
  await applyVersioning(s3);
  await applyLifecycle(s3);
  console.log('Done.');
}

main().catch(err => { console.error('Bucket provisioning failed:', err.message); process.exit(1); });
