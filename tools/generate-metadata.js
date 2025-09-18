#!/usr/bin/env node
// Generates metadata suggestions for HTML pages using OpenAI.
// Usage:
//   node tools/generate-metadata.js --glob "**/*.html" --apply=false
// Environment:
//   OPENAI_API_KEY (required)
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { glob: '**/*.html', apply: false };
  args.forEach((arg) => {
    if (arg.startsWith('--glob=')) result.glob = arg.split('=')[1];
    if (arg.startsWith('--apply=')) result.apply = arg.split('=')[1] === 'true';
  });
  return result;
}

function globFiles(pattern) {
  const cmd = process.platform === 'win32'
    ? `powershell -NoProfile -Command "Get-ChildItem -Recurse -Include ${pattern.replace('**/', '')} | % { $_.FullName }"`
    : `sh -lc 'ls -1 ${pattern}'`;
  const out = execSync(cmd, { cwd: process.cwd(), encoding: 'utf8' });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

async function callOpenAI(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You generate concise SEO metadata for HTML pages: title (<=60 chars), description (120-160 chars), og:title, og:description, keywords (<=8 comma-separated), and optional canonical URL if detectable. Return strict JSON with keys: title, description, ogTitle, ogDescription, keywords, canonical.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error: ${res.status} ${text}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  try {
    return JSON.parse(content);
  } catch (e) {
    return { error: 'Invalid JSON from model', raw: content };
  }
}

function extractMainText(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, 8000);
}

async function main() {
  const { glob: pattern, apply } = parseArgs();
  const files = globFiles(pattern).filter((f) => f.endsWith('.html'));
  if (files.length === 0) {
    console.log('No HTML files found.');
    process.exit(0);
  }
  const overridesPath = path.join(process.cwd(), 'metadata', 'overrides.json');
  let overrides = {};
  if (fs.existsSync(overridesPath)) {
    overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
  }
  const results = {};
  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8');
    const text = extractMainText(html);
    const prompt = `Generate metadata for this page. Return JSON with keys: title, description, ogTitle, ogDescription, keywords, canonical. Text: ${text}`;
    // eslint-disable-next-line no-await-in-loop
    const suggestion = await callOpenAI(prompt);
    results[file] = { suggestion, override: overrides[file] || null };
    if (apply && suggestion && !suggestion.error) {
      let updated = html;
      const ensureMeta = (name, content) => {
        if (!content) return;
        const metaTag = `<meta name="${name}" content="${content}">`;
        if (updated.includes(`name=\"${name}\"`)) {
          updated = updated.replace(new RegExp(`<meta[^>]+name=\"${name}\"[^>]+>`, 'i'), metaTag);
        } else {
          updated = updated.replace('</head>', `  ${metaTag}\n</head>`);
        }
      };
      const ensureProperty = (property, content) => {
        if (!content) return;
        const metaTag = `<meta property="${property}" content="${content}">`;
        if (updated.match(new RegExp(`<meta[^>]+property=\"${property}\"[^>]+>`, 'i'))) {
          updated = updated.replace(new RegExp(`<meta[^>]+property=\"${property}\"[^>]+>`, 'i'), metaTag);
        } else {
          updated = updated.replace('</head>', `  ${metaTag}\n</head>`);
        }
      };
      ensureMeta('description', suggestion.description);
      ensureMeta('keywords', suggestion.keywords);
      if (suggestion.title) {
        if (updated.match(/<title>.*?<\/title>/i)) {
          updated = updated.replace(/<title>.*?<\/title>/i, `<title>${suggestion.title}</title>`);
        } else {
          updated = updated.replace('</head>', `  <title>${suggestion.title}<\/title>\n</head>`);
        }
      }
      ensureProperty('og:title', suggestion.ogTitle || suggestion.title);
      ensureProperty('og:description', suggestion.ogDescription || suggestion.description);
      if (suggestion.canonical) {
        const link = `<link rel="canonical" href="${suggestion.canonical}">`;
        if (updated.match(/<link[^>]+rel=\"canonical\"[^>]*>/i)) {
          updated = updated.replace(/<link[^>]+rel=\"canonical\"[^>]*>/i, link);
        } else {
          updated = updated.replace('</head>', `  ${link}\n</head>`);
        }
      }
      fs.writeFileSync(file, updated);
    }
  }
  const outPath = path.join(process.cwd(), 'metadata', 'suggestions.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Wrote suggestions to ${outPath}`);
}

// polyfill fetch for Node 18-
if (typeof fetch === 'undefined') {
  // eslint-disable-next-line global-require
  global.fetch = require('node-fetch');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});


