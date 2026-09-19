// Builds www/ (what the Android app bundles) from the single source of truth, tools/dashboard.html.
// Run: node build_www.mjs   (then: npx cap sync android)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const www = path.join(here, 'www');
const { DEFAULT_CONFIG } = await import(pathToFileURL(path.join(here, '..', 'tools', 'scraper_config_defaults.mjs')).href);

fs.mkdirSync(www, { recursive: true });
let html = fs.readFileSync(path.join(here, '..', 'tools', 'dashboard.html'), 'utf-8');
const inject = '<script src="defaults.js"></script>\n<script src="scraper_lib.js"></script>\n<script src="standalone.js"></script>\n<style>';
if (!html.includes('<style>')) throw new Error('dashboard.html has no <style> tag to anchor the injection on');
html = html.replace('<style>', inject);
fs.writeFileSync(path.join(www, 'index.html'), html);
fs.writeFileSync(path.join(www, 'defaults.js'), 'window.__DEFAULT_CONFIG__ = ' + JSON.stringify(DEFAULT_CONFIG) + ';\n');
for (const f of ['scraper_lib.js', 'standalone.js']) fs.copyFileSync(path.join(here, 'src', f), path.join(www, f));
console.log('www/ built: index.html + defaults.js + scraper_lib.js + standalone.js');
