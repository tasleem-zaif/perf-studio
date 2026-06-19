/**
 * buildRunDirName — canonical name for every execution result directory.
 *
 * Format:
 *   {SuiteName}_{N}Users_{D}sDuration_Run{seq}   (duration mode)
 *   {SuiteName}_{N}Users_{L}Loops_Run{seq}        (loops mode)
 *
 * Rules:
 *  - suiteName: any non-alphanumeric chars → '_', consecutive '_' collapsed
 *  - iterMode 'duration' (or duration > 0 and loops <= 1): use duration label
 *  - otherwise: use loops label
 */
function buildRunDirName(suiteName, users, iterMode, loops, duration, runNumber) {
  const base = (suiteName || 'Run')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

  const u = users ? `_${users}Users` : '';

  const d = parseInt(duration) || 0;
  const l = parseInt(loops)    || 0;
  const useDuration = iterMode === 'duration' || (d > 0 && l <= 1 && iterMode !== 'loops');
  const p = useDuration && d > 0 ? `_${d}sDuration` : (l > 0 ? `_${l}Loops` : '');

  return `${base}${u}${p}_Run${runNumber}`;
}

/**
 * extractRunNumber — pull the sequential run number out of a result_dir path
 * regardless of whether it uses the old format (Run_3) or new (SuiteName_Run3).
 */
function extractRunNumber(resultDir) {
  if (!resultDir) return 0;
  const base = resultDir.split(/[/\\]/).pop() || '';
  const m = base.match(/Run_?(\d+)$/);
  return m ? parseInt(m[1]) : 0;
}

module.exports = { buildRunDirName, extractRunNumber };
