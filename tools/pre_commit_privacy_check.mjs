// Pre-commit privacy check - blocks a commit if any STAGED file contains your
// real phone number or email (the exact values from .env's CANDIDATE_PHONE /
// CANDIDATE_EMAIL). This exists because those values were accidentally
// committed and pushed to a public GitHub repo once already - see the
// .env / 01-candidate-profile.md placeholder pattern this enforces.
//
// Hard block: exact match against the real values in .env (very low false-positive
// rate, since it's a literal string match against data only you would know).
// Soft warning: any other email/Indonesian-phone-shaped string, in case new real
// contact data shows up somewhere before this script is updated - warns but does
// NOT block, since job postings/templates legitimately contain other emails.
//
// Installed as .git/hooks/pre-commit by tools/install_git_hooks.bat (or manually,
// see that file's comments). Bypass for a specific commit you've verified is safe:
//   git commit --no-verify

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

function loadEnvValue(key) {
  if (!existsSync('.env')) return null;
  const content = readFileSync('.env', 'utf-8');
  const m = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
  const val = m ? m[1].trim() : '';
  return val || null;
}

const knownPhone = loadEnvValue('CANDIDATE_PHONE');
const knownEmail = loadEnvValue('CANDIDATE_EMAIL');

// Normalizes to just the trailing digits after any country/leading-zero prefix,
// so "081234567890", "+62 812 3456 7890", and "6281234567890@s.whatsapp.net" (a
// WhatsApp JID) are all recognized as the same number regardless of format.
function phoneDigits(value) {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.replace(/^62/, '').replace(/^0/, '');
}
const knownPhoneDigits = phoneDigits(knownPhone);

function getStagedFiles() {
  const out = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf-8' });
  return out.split('\n').filter(Boolean).filter((f) => f !== '.env');
}

function getStagedContent(file) {
  try {
    return execSync(`git show :"${file}"`, { encoding: 'utf-8' });
  } catch {
    return null; // binary, deleted, or unreadable - skip
  }
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?62|0)8\d{8,11}/g;
const PLACEHOLDER_HINTS = /example\.com|your\.email|nama\.kamu|placeholder|@company\.com|xxxxxxxx/i;

const blocking = [];
const warnings = [];

for (const file of getStagedFiles()) {
  const content = getStagedContent(file);
  if (content == null) continue;

  content.split('\n').forEach((line, idx) => {
    const loc = `${file}:${idx + 1}`;

    if (knownPhone && line.includes(knownPhone)) {
      blocking.push(`${loc} - nomor HP asli kamu ketemu (cocok CANDIDATE_PHONE di .env)`);
    }
    if (knownEmail && line.toLowerCase().includes(knownEmail.toLowerCase())) {
      blocking.push(`${loc} - email asli kamu ketemu (cocok CANDIDATE_EMAIL di .env)`);
    }

    for (const m of line.match(EMAIL_RE) || []) {
      if (PLACEHOLDER_HINTS.test(m)) continue;
      if (knownEmail && m.toLowerCase() === knownEmail.toLowerCase()) continue; // already in blocking
      warnings.push(`${loc} - ada pola email: "${m}"`);
    }
    for (const m of line.match(PHONE_RE) || []) {
      if (knownPhoneDigits && phoneDigits(m) === knownPhoneDigits) {
        blocking.push(`${loc} - nomor HP asli kamu ketemu dalam format lain ("${m}") - cocok CANDIDATE_PHONE di .env`);
        continue;
      }
      warnings.push(`${loc} - ada pola nomor HP: "${m}"`);
    }
  });
}

if (warnings.length > 0) {
  console.warn('\n[pre-commit] Perhatian - ada pola email/nomor HP lain di file yang di-stage (bukan blocking, cuma info):');
  warnings.forEach((w) => console.warn('  ' + w));
}

if (blocking.length > 0) {
  console.error('\nCOMMIT DIBLOKIR - data kontak pribadi asli kamu ketemu di file yang mau di-commit:\n');
  blocking.forEach((b) => console.error('  ' + b));
  console.error('\nPindahin ke .env dulu (lihat CLAUDE.md bagian Identity buat contohnya), atau kalau kamu YAKIN ini aman:');
  console.error('  git commit --no-verify\n');
  process.exit(1);
}

console.log('[pre-commit] Privacy check lolos - gak ada data kontak pribadi asli di commit ini.');
process.exit(0);
