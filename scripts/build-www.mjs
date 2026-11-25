// Copies the website into www/, the folder Capacitor packs into the iOS and Android apps.
// The website itself has no build step; GitHub Pages serves the repo root as it is.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const FILES = [
  'index.html', 'styles.css', 'manifest.webmanifest', 'watch.html', 'privacy.html', 'support.html',
  'js', 'icons', 'media', 'questions/questions.csv',
];

rmSync('www', { recursive: true, force: true });
mkdirSync('www/questions', { recursive: true });
for (const f of FILES) cpSync(f, `www/${f}`, { recursive: true });
console.log('Copied the website into www/');
