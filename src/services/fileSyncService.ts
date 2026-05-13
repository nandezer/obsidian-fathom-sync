import { App, TFile, normalizePath } from "obsidian";
import type { CacheKey, NoteType } from "../types";
import type { ProcessedNote } from "./documentProcessor";
import { logger } from "../utils/logger";

/**
 * Manages the vault-side cache and write operations.
 *
 * Cache key format: `{recording_id}-{type}` (e.g. "145099015-summary")
 */
export class FileSyncService {
  /** recording_id + type → existing TFile */
  private cache = new Map<CacheKey, TFile>();

  constructor(private readonly app: App) {}

  cacheKey(recordingId: number, type: NoteType): CacheKey {
    return `${recordingId}-${type}`;
  }

  /**
   * Scan all markdown files in the vault and build the in-memory cache.
   * Only counts notes that were created BY THIS PLUGIN — identified by the
   * `synced_by: fathom-sync` frontmatter marker. This avoids colliding with
   * other plugins (e.g. Granola Sync) that also use `fathom_id`.
   */
  async buildCache(): Promise<void> {
    this.cache.clear();

    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const cache = this.app.metadataCache.getFileCache(file);
      const fm = cache?.frontmatter;
      if (!fm?.fathom_id || !fm?.type) continue;
      if (fm.synced_by !== "fathom-sync") continue;
      if (fm.type !== "summary" && fm.type !== "transcript") continue;

      const key = this.cacheKey(Number(fm.fathom_id), fm.type as NoteType);
      this.cache.set(key, file);
    }

    logger.info(`Cache built: ${this.cache.size} Fathom Sync notes found.`);
  }

  has(recordingId: number, type: NoteType): boolean {
    return this.cache.has(this.cacheKey(recordingId, type));
  }

  /**
   * Write a note to the vault.
   * If the note already exists in the cache it is skipped (immutable).
   * Returns true if the note was written, false if skipped.
   */
  async saveNote(
    recordingId: number,
    type: NoteType,
    note: ProcessedNote
  ): Promise<boolean> {
    const key = this.cacheKey(recordingId, type);

    if (this.cache.has(key)) {
      logger.debug(`Skipping existing note: ${key}`);
      return false;
    }

    const folderPath = normalizePath(note.folder);
    const filePath = normalizePath(`${note.folder}/${note.filename}.md`);

    await this.ensureFolder(folderPath);

    try {
      const file = await this.app.vault.create(filePath, note.content);
      this.cache.set(key, file);
      logger.info(`Created: ${filePath}`);
      return true;
    } catch (err) {
      // Race condition: file was created between cache build and now
      if ((err as { message?: string })?.message?.includes("already exists")) {
        logger.warn(`File already exists, updating cache entry: ${filePath}`);
        const existing = this.app.vault.getAbstractFileByPath(filePath);
        if (existing instanceof TFile) {
          this.cache.set(key, existing);
        }
        return false;
      }
      throw err;
    }
  }

  private async ensureFolder(folderPath: string): Promise<void> {
    const exists = this.app.vault.getAbstractFileByPath(folderPath);
    if (!exists) {
      await this.app.vault.createFolder(folderPath);
    }
  }
}
