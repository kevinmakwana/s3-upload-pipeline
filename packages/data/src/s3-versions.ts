import { DeleteObjectsCommand, ListObjectVersionsCommand, type S3Client } from '@aws-sdk/client-s3';

/**
 * Removes every version and delete marker of exactly this key (and nothing that merely shares its
 * prefix). A versioned bucket keeps old versions after a plain delete, so this is what "gone" means.
 * Throws if S3 reports any object it could not delete.
 */
export async function deleteAllVersions(s3: Pick<S3Client, 'send'>, bucket: string, key: string): Promise<void> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }));
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
      .filter((v) => v.Key === key && v.VersionId)
      .map((v) => ({ Key: v.Key!, VersionId: v.VersionId! }));
    if (objects.length) {
      const result = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
      if (result.Errors?.length) {
        const first = result.Errors[0]!;
        throw new Error(`S3 could not delete ${first.Key} (${first.VersionId}): ${first.Code}`);
      }
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined || versionIdMarker !== undefined);
}
