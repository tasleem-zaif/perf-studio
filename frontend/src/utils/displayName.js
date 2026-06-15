/**
 * displayName.js
 * Clean display names for the UI — IDs/UUIDs are stored in the DB,
 * no need to show them on screen.
 */

/** Project display name — just the human-readable name */
export function projectDirName(project) {
  if (!project) return '';
  return project.name || '';
}

/** Collection display name — just the human-readable name */
export function collectionDirName(collection) {
  if (!collection) return '';
  return collection.name || '';
}

/** Collection label with environment — Name / Env */
export function collectionPathLabel(collection) {
  if (!collection) return '';
  const env = collection.environment;
  return env ? `${collection.name} / ${env}` : (collection.name || '');
}
