import type { Addressing } from "./config";

export type Preset = {
  id: string;
  name: string;
  endpoint: string;
  region: string;
  regionHint: string;
  addressing: Addressing;
  keysUrl: string | null;
};

export const PRESETS: Preset[] = [
  { id: "aws", name: "AWS S3", endpoint: "https://s3.{region}.amazonaws.com", region: "us-east-1", regionHint: "e.g. eu-west-3", addressing: "virtual", keysUrl: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html" },
  { id: "r2", name: "Cloudflare R2", endpoint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com", region: "auto", regionHint: "auto", addressing: "path", keysUrl: "https://developers.cloudflare.com/r2/api/tokens/" },
  { id: "b2", name: "Backblaze B2", endpoint: "https://s3.{region}.backblazeb2.com", region: "us-west-004", regionHint: "shown on the bucket page, e.g. eu-central-003", addressing: "path", keysUrl: "https://www.backblaze.com/docs/cloud-storage-create-and-manage-app-keys" },
  { id: "wasabi", name: "Wasabi", endpoint: "https://s3.{region}.wasabisys.com", region: "us-east-1", regionHint: "e.g. eu-central-1", addressing: "path", keysUrl: "https://docs.wasabi.com/docs/creating-a-user-account-and-access-key" },
  { id: "minio", name: "MinIO", endpoint: "http://localhost:9000", region: "us-east-1", regionHint: "usually us-east-1", addressing: "path", keysUrl: "https://min.io/docs/minio/linux/administration/identity-access-management/minio-user-management.html" },
  { id: "hetzner", name: "Hetzner", endpoint: "https://{region}.your-objectstorage.com", region: "fsn1", regionHint: "fsn1, nbg1 or hel1", addressing: "virtual", keysUrl: "https://docs.hetzner.com/storage/object-storage/getting-started/generating-s3-keys/" },
  { id: "scaleway", name: "Scaleway", endpoint: "https://s3.{region}.scw.cloud", region: "fr-par", regionHint: "fr-par, nl-ams or pl-waw", addressing: "path", keysUrl: "https://www.scaleway.com/en/docs/iam/how-to/create-api-keys/" },
  { id: "other", name: "Other", endpoint: "", region: "", regionHint: "leave empty for us-east-1", addressing: "path", keysUrl: null },
];

export function endpointFor(preset: Preset, region: string): string {
  return preset.endpoint.replace("{region}", region.trim() || preset.region);
}
