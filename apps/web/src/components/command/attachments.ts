'use client';

/**
 * Shared attachment processing for command bars.
 *
 * Extracted from AeroTunerInputBar so the unified command bar (and any future
 * input surface) processes dropped/pasted/selected files identically: images
 * get object previews, code/text files under 300KB get their first 30KB
 * captured as inline text content, everything else is metadata-only.
 */

export interface AttachedMedia {
  id: string;
  name: string;
  size: number;
  type: string;
  category: 'image' | 'video' | 'code' | 'file';
  previewUrl?: string;
  textContent?: string;
}

const CODE_EXT =
  /\.(js|jsx|ts|tsx|py|go|rs|cpp|c|h|cs|html|css|json|yaml|yml|toml|sql|sh|env)$/i;

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function categorizeFile(file: File): AttachedMedia['category'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (CODE_EXT.test(file.name)) return 'code';
  return 'file';
}

/** Build preview/text payload for one file. Never throws. */
export async function processOneFile(file: File): Promise<AttachedMedia> {
  const category = categorizeFile(file);

  let previewUrl: string | undefined;
  let textContent: string | undefined;

  if (category === 'image' || category === 'video') {
    try {
      previewUrl = URL.createObjectURL(file);
    } catch {
      /* ignore */
    }
  } else if (file.size <= 300_000) {
    try {
      textContent = (await file.text()).slice(0, 30_000);
    } catch {
      /* ignore */
    }
  }

  return {
    id: makeId(),
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    category,
    previewUrl,
    textContent,
  };
}

/** Process a batch of files into attachment metadata. */
export async function processFiles(files: FileList | File[]): Promise<AttachedMedia[]> {
  return Promise.all(Array.from(files).map(processOneFile));
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Best-effort object-URL cleanup for a removed attachment. */
export function revokePreview(item?: AttachedMedia | null): void {
  if (item?.previewUrl) {
    try {
      URL.revokeObjectURL(item.previewUrl);
    } catch {
      /* ignore */
    }
  }
}
