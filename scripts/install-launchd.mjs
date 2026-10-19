import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const library = join(homedir(), 'Library');
const launchAgents = join(library, 'LaunchAgents');
const logs = join(library, 'Logs');
const label = 'com.assemble.api';
const destination = join(launchAgents, `${label}.plist`);
const escapeXml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
const args = [process.execPath, join(root, 'server', 'index.mjs'), '--production'];
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((arg) => `<string>${escapeXml(arg)}</string>`).join('')}</array>
  <key>WorkingDirectory</key><string>${escapeXml(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escapeXml(join(logs, 'assemble-api.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(logs, 'assemble-api-error.log'))}</string>
</dict>
</plist>
`;

mkdirSync(launchAgents, { recursive: true });
mkdirSync(logs, { recursive: true });
writeFileSync(destination, plist, { mode: 0o600 });
console.log(`Created ${destination}`);
console.log('Load it with:');
console.log(`launchctl bootstrap gui/$(id -u) "${destination}"`);
console.log(`launchctl kickstart -k gui/$(id -u)/${label}`);
