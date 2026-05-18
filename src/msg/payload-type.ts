import path from 'path';

export type PayloadFileType = 'image' | 'video' | 'voice' | 'file';

const EXT_TYPE_MAP: Record<string, PayloadFileType> = {
  // image
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image',
  '.gif': 'image', '.webp': 'image', '.svg': 'image',
  '.bmp': 'image', '.heic': 'image', '.heif': 'image',
  // video
  '.mp4': 'video', '.mov': 'video', '.webm': 'video',
  '.avi': 'video', '.mkv': 'video', '.m4v': 'video',
  // voice
  '.opus': 'voice', '.mp3': 'voice', '.aac': 'voice',
  '.m4a': 'voice', '.wav': 'voice', '.flac': 'voice', '.ogg': 'voice',
};

/**
 * 按扩展名推断 payload.type。
 * 未识别的扩展名归类为 'file'。
 */
export function inferPayloadType(filename: string): PayloadFileType {
  const ext = path.extname(filename).toLowerCase();
  return EXT_TYPE_MAP[ext] ?? 'file';
}

/**
 * 校验显式传入的 --as 值。
 */
export function isValidPayloadType(value: string): value is PayloadFileType {
  return value === 'image' || value === 'video' || value === 'voice' || value === 'file';
}
