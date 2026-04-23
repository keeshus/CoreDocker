import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get version from command line
let version = process.argv[2];

if (!version) {
  console.error('Please provide a version number.');
  process.exit(1);
}

// Remove leading 'v' if present
if (version.startsWith('v')) {
  version = version.substring(1);
}

console.log(`Syncing version to: ${version}`);

const filesToUpdate = [
  path.resolve(__dirname, '../package.json'),
  path.resolve(__dirname, '../backend/package.json'),
  path.resolve(__dirname, '../frontend/package.json')
];

for (const file of filesToUpdate) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(data);
    
    if (json.version !== version) {
      json.version = version;
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
      console.log(`Updated ${path.relative(path.resolve(__dirname, '..'), file)}`);
    } else {
      console.log(`Version already matches in ${path.relative(path.resolve(__dirname, '..'), file)}`);
    }
  } catch (err) {
    console.error(`Failed to update ${file}: ${err.message}`);
  }
}
