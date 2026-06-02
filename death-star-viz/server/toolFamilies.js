/**
 * toolFamilies.js
 *
 * Maps a Claude Code `tool_name` to one of a SMALL set of visual "families"
 * the client knows how to animate. The server decides the family so the
 * client never has to keep a tool->animation table in sync.
 *
 * Families (the client relies on exactly these string values):
 *   "exec"     — Bash / shell execution
 *   "read"     — Read / Grep / Glob / LS (inspecting things)
 *   "edit"     — Edit / Write / MultiEdit / NotebookEdit (mutating files)
 *   "scan"     — WebSearch / WebFetch (reaching outside)
 *   "delegate" — Task / Agent (spawning subagents)
 *   "generic"  — anything else / unknown
 */

// Exact (case-insensitive) tool-name -> family lookups. Kept as a map so it is
// easy to extend. We normalise by lower-casing and stripping non-alphanumerics
// so "Multi-Edit", "MultiEdit", "multi_edit" all collapse to the same key.
const EXACT = new Map([
  ['bash', 'exec'],
  ['read', 'read'],
  ['grep', 'read'],
  ['glob', 'read'],
  ['ls', 'read'],
  ['edit', 'edit'],
  ['write', 'edit'],
  ['multiedit', 'edit'],
  ['notebookedit', 'edit'],
  ['websearch', 'scan'],
  ['webfetch', 'scan'],
  ['task', 'delegate'],
  ['agent', 'delegate'],
]);

/**
 * Normalise a tool name to a comparison key: lower-case, alphanumerics only.
 * @param {*} name
 * @returns {string}
 */
function normalise(name) {
  if (typeof name !== 'string') return '';
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve the visual family for a tool name. Always returns a valid family
 * string; never throws.
 * @param {*} toolName
 * @returns {'exec'|'read'|'edit'|'scan'|'delegate'|'generic'}
 */
export function toolFamily(toolName) {
  const key = normalise(toolName);
  if (!key) return 'generic';
  if (EXACT.has(key)) return EXACT.get(key);

  // Loose fallbacks so unseen variants still land somewhere sensible.
  if (key.includes('bash') || key.includes('shell') || key.includes('exec')) return 'exec';
  if (key.includes('edit') || key.includes('write')) return 'edit';
  if (key.includes('read') || key.includes('grep') || key.includes('glob')) return 'read';
  if (key.includes('web') || key.includes('fetch') || key.includes('search')) return 'scan';
  if (key.includes('task') || key.includes('agent') || key.includes('delegate')) return 'delegate';

  return 'generic';
}

// ── Human-readable action label ───────────────────────────────────────────────
// Build a short "verb + real target" phrase for the floating sprite label, e.g.
//   Bash {command:"npm test"}        -> "Running npm test"
//   Read {file_path:".../world.js"}   -> "Reading world.js"
//   Edit {file_path:".../render.js"}  -> "Editing render.js"
//   Grep {pattern:"TODO"}             -> "Searching \"TODO\""
//   WebFetch {url:"https://x.com/y"}  -> "Fetching x.com"
//   Task {subagent_type:"searcher"}   -> "Delegating → searcher"
// Always returns a non-empty string; never throws (any field may be missing).

const FAMILY_VERB = {
  exec: 'Running',
  read: 'Reading',
  edit: 'Editing',
  scan: 'Searching',
  delegate: 'Delegating',
  generic: 'Working',
};

function basename(p) {
  if (typeof p !== 'string' || p.length === 0) return '';
  const cleaned = p.replace(/[/\\]+$/, '');
  const seg = cleaned.split(/[/\\]/);
  return seg[seg.length - 1] || cleaned;
}

function squish(s, n) {
  const str = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (str.length <= n) return str;
  return str.slice(0, Math.max(1, n - 1)) + '…';
}

function hostOf(url) {
  if (typeof url !== 'string') return '';
  // strip scheme + path without needing the URL constructor (defensive)
  const m = url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0];
  return m.replace(/^www\./, '');
}

/**
 * @param {*} toolName
 * @param {*} toolInput  the hook's tool_input object (may be absent / partial)
 * @returns {string} a short "<Verb> <target>" phrase
 */
export function toolActionLabel(toolName, toolInput) {
  const fam = toolFamily(toolName);
  const verb = FAMILY_VERB[fam] || 'Working';
  const inp = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const key = normalise(toolName);
  let target = '';

  switch (key) {
    case 'bash':
      target = squish(inp.command || inp.cmd || '', 80);
      break;
    case 'read':
    case 'edit':
    case 'write':
    case 'multiedit':
    case 'notebookedit':
      target = basename(inp.file_path || inp.path || inp.notebook_path || '');
      break;
    case 'grep':
      target = inp.pattern ? `"${squish(inp.pattern, 50)}"` : '';
      break;
    case 'glob':
      target = squish(inp.pattern || inp.glob || '', 50);
      break;
    case 'ls':
      target = basename(inp.path || '') || '';
      break;
    case 'websearch':
      target = inp.query ? `"${squish(inp.query, 60)}"` : '';
      break;
    case 'webfetch':
      target = hostOf(inp.url);
      break;
    case 'task':
    case 'agent':
      target = squish(inp.subagent_type || inp.description || '', 50);
      break;
    default:
      // family-based fallback for unmapped tools
      if (fam === 'exec') target = squish(inp.command || inp.cmd || '', 80);
      else if (fam === 'edit' || fam === 'read') target = basename(inp.file_path || inp.path || '');
      else if (fam === 'scan') target = inp.query ? `"${squish(inp.query, 60)}"` : hostOf(inp.url);
      break;
  }

  if (!target) {
    // No legible target — fall back to the tool's own name so the label still
    // says something useful (e.g. "Working · TodoWrite").
    const tn = typeof toolName === 'string' && toolName ? toolName : 'tool';
    return `${verb} · ${tn}`;
  }
  if (fam === 'delegate') return `Delegating → ${target}`;
  return `${verb} ${target}`;
}
