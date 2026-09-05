/**
 * storage.js — uploads images to Supabase Storage.
 *
 * Buckets (create these in the Supabase dashboard):
 *   - product-images   (public)
 *   - eod-receipts     (private — only the owning merchant should read these)
 */
const supabase = require("../db/supabase");

/**
 * Upload a base64 data URL to Supabase Storage.
 * Returns the public URL of the uploaded file.
 *
 * @param {string} bucket  - Supabase bucket name
 * @param {string} path    - e.g. "merchant-id/filename.jpg"
 * @param {string} dataUrl - "data:image/jpeg;base64,..."
 */
async function uploadBase64Image(bucket, path, dataUrl) {
  // Strip the data URL prefix to get raw base64
  const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
  if (!matches) throw new Error("Invalid base64 image format.");

  const mimeType = matches[1];
  const buffer = Buffer.from(matches[2], "base64");

  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, {
      contentType: mimeType,
      upsert: true,  // overwrite if re-uploading the same path
    });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

/**
 * Upload a multer-processed file buffer to Supabase Storage.
 * Returns the public URL.
 */
async function uploadFileBuffer(bucket, path, buffer, mimeType) {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(path, buffer, { contentType: mimeType, upsert: true });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

module.exports = { uploadBase64Image, uploadFileBuffer };
