import * as ImagePicker from 'expo-image-picker';
import { REVIEW_PHOTO_BUCKET, supabase } from '../api/supabase';
import { reviewPhotoPath } from './reviews';

/** Pick a photo from the library. Returns null if the user cancels. */
export async function pickEvidencePhoto(): Promise<ImagePicker.ImagePickerAsset | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    quality: 0.6,
    allowsEditing: false,
  });
  if (result.canceled) return null;
  return result.assets[0] ?? null;
}

/**
 * Uploads to Storage bucket `review-photos` at `<group>/<user>/<timestamp>.<ext>` (the layout the
 * bucket's RLS policy checks) and returns the object path for open_review(p_photo_path).
 */
export async function uploadEvidencePhoto(
  asset: ImagePicker.ImagePickerAsset,
  groupId: string,
  userId: string,
): Promise<string> {
  const contentType = asset.mimeType ?? 'image/jpeg';
  const path = reviewPhotoPath({ groupId, userId, nowMs: Date.now(), mimeType: contentType });
  const body = await (await fetch(asset.uri)).arrayBuffer();
  const { error } = await supabase.storage.from(REVIEW_PHOTO_BUCKET).upload(path, body, { contentType, upsert: false });
  if (error) throw new Error(error.message);
  return path;
}
