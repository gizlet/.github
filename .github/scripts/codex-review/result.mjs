// Review result validation and rendering.

export const CHECK_NAME = 'Codex Code Review';
export const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];

const MAX_TITLE = 300;
const MAX_BODY = 6000;
const MAX_SUMMARY = 4000;
const MAX_CHECK_TEXT = 60000;

export function parseBlockingSeverities(value) {
  const items = String(value ?? '').split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
  for (const item of items) {
    if (!SEVERITIES.includes(item)) throw new Error(`Unknown blocking severity: ${item}`);
  }
  return new Set(items);
}

// Model output may quote untrusted diff text; never notify users or teams.
export function neutralizeMentions(text) {
  return String(text).replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b');
}

const clip = (text, limit) => {
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
};

export function parseReviewResult(text) {
  let source = String(text ?? '').trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(source);
  if (fenced) source = fenced[1];
  const data = JSON.parse(source);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Review result must be an object.');
  if (typeof data.summary !== 'string') throw new Error('Review result summary must be a string.');
  if (!Array.isArray(data.findings)) throw new Error('Review result findings must be an array.');
  const findings = data.findings.map((finding, index) => {
    const where = `findings[${index}]`;
    if (!finding || typeof finding !== 'object') throw new Error(`${where} must be an object.`);
    const { title, body, severity, path, line } = finding;
    if (typeof title !== 'string' || !title.trim()) throw new Error(`${where}.title must be a non-empty string.`);
    if (typeof body !== 'string') throw new Error(`${where}.body must be a string.`);
    if (!SEVERITIES.includes(severity)) throw new Error(`${where}.severity must be one of ${SEVERITIES.join(', ')}.`);
    if (typeof path !== 'string') throw new Error(`${where}.path must be a string.`);
    if (!Number.isSafeInteger(line) || line < 0) throw new Error(`${where}.line must be a non-negative integer.`);
    return { title: title.trim(), body: body.trim(), severity, path: path.trim().replace(/^\.\//, ''), line };
  });
  findings.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  return { summary: data.summary.trim(), findings };
}

export function conclusionFor(findings, blocking) {
  return findings.some((finding) => blocking.has(finding.severity)) ? 'failure' : 'success';
}

const findingHeading = (finding) => `**[${finding.severity}] ${neutralizeMentions(clip(finding.title, MAX_TITLE))}**`;
const findingText = (finding) => [
  findingHeading(finding),
  '',
  neutralizeMentions(clip(finding.body, MAX_BODY)),
].join('\n');
const location = (finding) => (finding.path
  ? `\`${finding.path.replace(/`/g, "'")}${finding.line > 0 ? `:${finding.line}` : ''}\``
  : 'General');

function verdictLine(conclusion, findings, blocking) {
  const blockingCount = findings.filter((finding) => blocking.has(finding.severity)).length;
  if (conclusion === 'success') {
    return findings.length
      ? `✅ No blocking findings (${findings.length} non-blocking).`
      : '✅ No findings.';
  }
  return `❌ ${blockingCount} blocking finding${blockingCount === 1 ? '' : 's'} (${[...blocking].join(', ')}).`;
}

/**
 * Builds a native PR review. Findings anchored to commentable diff lines
 * become inline comments; the rest are listed in the review body.
 */
export function buildReview({ summary, findings, lines, conclusion, blocking, headSha }) {
  const comments = [];
  const unanchored = [];
  for (const finding of findings) {
    if (finding.path && finding.line > 0 && lines.get(finding.path)?.has(finding.line)) {
      comments.push({ path: finding.path, line: finding.line, side: 'RIGHT', body: findingText(finding) });
    } else {
      unanchored.push(finding);
    }
  }
  const body = [
    `### ${CHECK_NAME}`,
    '',
    verdictLine(conclusion, findings, blocking),
    '',
    neutralizeMentions(clip(summary, MAX_SUMMARY)),
  ];
  if (unanchored.length) {
    body.push('', '#### Findings without an inline location');
    for (const finding of unanchored) {
      body.push('', `${location(finding)}: ${findingText(finding)}`);
    }
  }
  body.push('', `<sub>Reviewed head \`${headSha}\`. Push changes, then comment a new review request to review the new head.</sub>`);
  return { body: body.join('\n'), comments };
}

export function buildCheckOutput({ summary, findings, conclusion, blocking }) {
  const text = findings.map((finding) => `${location(finding)}: ${findingText(finding)}`).join('\n\n---\n\n');
  return {
    title: verdictLine(conclusion, findings, blocking),
    summary: neutralizeMentions(clip(summary || 'No summary.', MAX_SUMMARY)),
    text: text ? clip(text, MAX_CHECK_TEXT) : undefined,
  };
}
