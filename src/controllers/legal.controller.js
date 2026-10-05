const fs = require('fs');
const path = require('path');
const catchAsync = require('../utils/catchAsync');
const ApiResponse = require('../utils/apiResponse');
const ApiError = require('../utils/apiError');

// Legal pages (Privacy Policy, Terms of Use) for the app and the website.
// The text lives in src/content/legal/*.txt — edit the file, restart the
// server, and both the app and the website show the new version.

const DOCS = {
  'privacy-policy': { file: 'privacy-policy.txt', title: 'Privacy Policy' },
  'terms-of-use': { file: 'terms-of-use.txt', title: 'Terms of Use' },
};

const DIR = path.join(__dirname, '..', 'content', 'legal');
const cache = new Map(); // slug -> { mtimeMs, doc }

/**
 * Turns the plain text into sections:
 *   "1. Introduction"          → a new section (numbers must run 1, 2, 3 …)
 *   "ANNEXURE A — Title"       → a new section
 *   "5.1 Something" / "A.1 …"  → a sub-heading inside a section
 *   "- text"                   → bullet
 *   "1. text" (inside a list)  → numbered item
 *   anything else              → paragraph
 */
function parse(raw, fallbackTitle) {
  const lines = raw.replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;

  const doc = { title: fallbackTitle, subtitle: '', updated: '', effective: '', intro: [], sections: [] };
  // Header: title, optional note, dates — until the first blank line.
  if (i < lines.length) {
    i += 1; // the all-caps title line in the file; we use the clean title above
    for (; i < lines.length && lines[i].trim(); i += 1) {
      const line = lines[i].trim();
      const updated = line.match(/^last updated:\s*(.+)$/i);
      const effective = line.match(/^effective date:\s*(.+)$/i);
      if (updated) doc.updated = updated[1];
      else if (effective) doc.effective = effective[1];
      else doc.subtitle = doc.subtitle ? `${doc.subtitle} ${line}` : line;
    }
  }

  let expected = 1;
  let current = null; // section being filled
  const push = (block) => (current ? current.blocks.push(block) : doc.intro.push(block));

  for (; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;

    const section = line.match(/^(\d{1,2})\.\s+(.+)$/);
    if (section && Number(section[1]) === expected) {
      current = { id: `s${expected}`, number: section[1], title: section[2], blocks: [] };
      doc.sections.push(current);
      expected += 1;
      continue;
    }
    const annexure = line.match(/^ANNEXURE\s+([A-Z])\s*[—–-]\s*(.+)$/i);
    if (annexure) {
      current = { id: `annexure-${annexure[1].toLowerCase()}`, number: `Annexure ${annexure[1]}`, title: annexure[2], blocks: [] };
      doc.sections.push(current);
      continue;
    }
    if (/^(\d+|[A-Z])\.\d+\s+\S/.test(line)) {
      push({ type: 'h', text: line });
      continue;
    }
    if (line.startsWith('- ')) {
      push({ type: 'li', text: line.slice(2).trim() });
      continue;
    }
    const numbered = line.match(/^(\d+)\.\s+(.+)$/);
    if (numbered) {
      push({ type: 'ol', n: Number(numbered[1]), text: numbered[2] });
      continue;
    }
    push({ type: 'p', text: line });
  }
  return doc;
}

function load(slug) {
  const meta = DOCS[slug];
  if (!meta) return null;
  const file = path.join(DIR, meta.file);
  const { mtimeMs } = fs.statSync(file);
  const hit = cache.get(slug);
  if (hit && hit.mtimeMs === mtimeMs) return hit.doc;
  const doc = { slug, ...parse(fs.readFileSync(file, 'utf8'), meta.title) };
  cache.set(slug, { mtimeMs, doc });
  return doc;
}

/** GET /api/legal — which documents exist. */
const listDocs = catchAsync(async (req, res) => {
  const docs = Object.keys(DOCS).map((slug) => {
    const d = load(slug);
    return { slug, title: d.title, updated: d.updated };
  });
  return new ApiResponse(200, docs, 'Legal documents').send(res);
});

/** GET /api/legal/:slug — one document, split into sections. */
const getDoc = catchAsync(async (req, res) => {
  const doc = load(req.params.slug);
  if (!doc) throw ApiError.notFound('Document not found');
  res.set('Cache-Control', 'public, max-age=600');
  return new ApiResponse(200, doc, doc.title).send(res);
});

module.exports = { listDocs, getDoc, parse };