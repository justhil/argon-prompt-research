import { BucketClient } from './bucket_client.mjs';

export async function uploadProductImage(bucketName, fileName, buffer, client = new BucketClient()) {
  const cleanName = fileName.trim().replace(/\s+/g, '-');
  const bucket = client.fromBucket(bucketName);
  const { error, key } = await bucket.putBlob(cleanName, buffer);
  if (error) throw new Error(error);
  const { signedUrl } = bucket.resolveSignedUrl(key);
  return signedUrl;
}
