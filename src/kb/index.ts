export {
  KB_FILE_VERSION,
  MAX_ENTRIES_PER_USER,
  MAX_SHARED_ENTRIES,
  MAX_TITLE_CHARS,
  MAX_BODY_CHARS,
  MAX_TAGS_PER_ENTRY,
  MAX_TAG_CHARS,
  MAX_SEARCH_RESULTS,
  MAX_LIST_RESULTS,
  MAX_SUMMARY_CHARS,
  KB_ID_PATTERN,
  TAG_PATTERN,
  normalizeTag,
  normalizeTags,
  assertKbId,
  assertUserKbFileCoherent,
  assertSharedKbFileCoherent,
  toListRow,
  type KbScope,
  type KbProvenance,
  type KbRef,
  type KnowledgeEntry,
  type UserKbFile,
  type SharedKbFile,
  type KbListRow,
} from './types.js';

export {
  userKbFilePath,
  sharedKbFilePath,
  loadUserKbFile,
  listEntriesForUser,
  ensureUserKbFileForCreate,
  saveUserKbFile,
  loadSharedKbFile,
  saveSharedKbFile,
  withKbFileLock,
} from './kb-file.js';

export { filterEntries, searchEntries } from './search.js';

export {
  assertCanRead,
  assertCanWrite,
  listKb,
  searchKb,
  getKb,
  createKb,
  updateKb,
  deleteKb,
  type CreateKbInput,
  type UpdateKbInput,
} from './service.js';
