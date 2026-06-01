/**
 * Patches a JMeter JMX file with runtime parameters by directly replacing
 * ThreadGroup XML values. This works regardless of whether the AI-generated
 * JMX uses ${__P(threads)} references or hardcoded values.
 *
 * Returns the path to a temporary JMX file. Caller must delete it when done.
 */
const fs = require('fs');

function patchJmxForParams(jmxPath, { vusers, rampup, duration, loops, iter_mode }) {
  let c = fs.readFileSync(jmxPath, 'utf8');

  // Virtual users
  if (vusers != null) {
    c = c
      .replace(/(<stringProp name="ThreadGroup\.num_threads">)[^<]*/g, `$1${vusers}`)
      .replace(/(<intProp name="ThreadGroup\.num_threads">)[^<]*/g, `$1${vusers}`);
  }

  // Ramp-up period
  if (rampup != null) {
    c = c
      .replace(/(<stringProp name="ThreadGroup\.ramp_time">)[^<]*/g, `$1${rampup}`)
      .replace(/(<intProp name="ThreadGroup\.ramp_time">)[^<]*/g, `$1${rampup}`);
  }

  if (iter_mode === 'duration' && duration != null) {
    // Set duration value
    c = c
      .replace(/(<stringProp name="ThreadGroup\.duration">)[^<]*/g, `$1${duration}`)
      .replace(/(<longProp name="ThreadGroup\.duration">)[^<]*/g,   `$1${duration}`)
      .replace(/(<intProp name="ThreadGroup\.duration">)[^<]*/g,    `$1${duration}`);

    // If ThreadGroup.duration property is missing entirely, inject it
    if (!/<[a-z]+Prop name="ThreadGroup\.duration"/.test(c)) {
      c = c.replace(
        /(<ThreadGroup\b[^>]*>)/,
        `$1\n        <stringProp name="ThreadGroup.duration">${duration}</stringProp>`
      );
    }

    // Enable scheduler — replace existing boolProp if present
    if (/<boolProp name="ThreadGroup\.scheduler">/.test(c)) {
      c = c.replace(/(<boolProp name="ThreadGroup\.scheduler">)[^<]*/g, '$1true');
    } else {
      // Inject scheduler=true right before </ThreadGroup>
      c = c.replace(
        /(<\/ThreadGroup>)/g,
        `        <boolProp name="ThreadGroup.scheduler">true</boolProp>\n$1`
      );
    }

    // Set loops to -1 (scheduler controls stop, not loop count)
    c = c
      .replace(/(<stringProp name="LoopController\.loops">)[^<]*/g, '$1-1')
      .replace(/(<intProp name="LoopController\.loops">)[^<]*/g,    '$1-1');

    // Also make sure continue_forever is false (scheduler takes over)
    c = c.replace(/(<boolProp name="LoopController\.continue_forever">)[^<]*/g, '$1false');

  } else if (iter_mode === 'loops' && loops != null) {
    // Disable scheduler, set explicit loop count
    if (/<boolProp name="ThreadGroup\.scheduler">/.test(c)) {
      c = c.replace(/(<boolProp name="ThreadGroup\.scheduler">)[^<]*/g, '$1false');
    } else {
      c = c.replace(
        /(<\/ThreadGroup>)/g,
        `        <boolProp name="ThreadGroup.scheduler">false</boolProp>\n$1`
      );
    }
    c = c
      .replace(/(<stringProp name="LoopController\.loops">)[^<]*/g, `$1${loops}`)
      .replace(/(<intProp name="LoopController\.loops">)[^<]*/g,    `$1${loops}`);
  }

  const tempPath = jmxPath + '.runtime.jmx';
  fs.writeFileSync(tempPath, c, 'utf8');
  return tempPath;
}

module.exports = { patchJmxForParams };
