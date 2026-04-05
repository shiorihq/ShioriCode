import { UTApi, UTFile } from "uploadthing/server";

const utapi = new UTApi();

const UPLOADTHING_FILE_PATH_PREFIX = "/f/";

export async function uploadToUploadThing(
  file: File,
  options: { filename: string; contentType: string },
): Promise<{ url: string; key: string }> {
  const utFile = new UTFile([file], options.filename, { type: options.contentType });

  const result = await utapi.uploadFiles(utFile, { acl: "public-read" });

  if (!result || result.error) {
    throw new Error(result?.error?.message ?? "UploadThing upload failed");
  }

  if (!result.data?.ufsUrl) {
    throw new Error("UploadThing did not return a file URL");
  }

  return { url: result.data.ufsUrl, key: result.data.key };
}

export async function deleteUploadThingFileByUrl(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;

    const hostname = parsed.hostname.toLowerCase();
    const isUploadThing =
      hostname === "utfs.io" || (hostname.endsWith(".ufs.sh") && hostname !== "ufs.sh");
    if (!isUploadThing) return false;

    if (!parsed.pathname.startsWith(UPLOADTHING_FILE_PATH_PREFIX)) return false;

    const key = decodeURIComponent(
      parsed.pathname.slice(UPLOADTHING_FILE_PATH_PREFIX.length).trim(),
    );
    if (!key) return false;

    await utapi.deleteFiles(key);
    return true;
  } catch {
    return false;
  }
}
