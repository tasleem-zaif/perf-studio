/**
 * displayName.js
 * Formats project/collection names to match their local directory structure.
 *
 * Project directory:    ProjectName_ID_UUID      e.g. API_Load_Test_5_847291
 * Collection directory: CollectionName_ID/Env    e.g. APICollection_3/QA
 */

/** Sanitise a raw name the same way the backend does for folder creation */
function safeName(name) {
  return (name || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Project display name — mirrors the on-disk folder name.
 * Format: Name_ID_UUID  (e.g. API_Load_Test_5_847291)
 */
export function projectDirName(project) {
  if (!project) return '';
  const safe = safeName(project.name);
  const uuid = project.uuid || '';
  return uuid ? `${safe}_${project.id}_${uuid}` : `${safe}_${project.id}`;
}

/**
 * Collection display name — mirrors the on-disk folder name.
 * Format: Name_ID  (e.g. APICollection_3)
 */
export function collectionDirName(collection) {
  if (!collection) return '';
  return `${safeName(collection.name)}_${collection.id}`;
}

/**
 * Collection full path label — Name_ID / Env
 * e.g. APICollection_3 / QA
 */
export function collectionPathLabel(collection) {
  if (!collection) return '';
  const base = collectionDirName(collection);
  const env  = collection.environment;
  return env ? `${base} / ${env}` : base;
}
