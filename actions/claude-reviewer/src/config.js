const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

function loadConfig() {
  const configPath = path.join(process.env.CONFIG_PATH, 'severity-rules.yml');
  try {
    const file = fs.readFileSync(configPath, 'utf8');
    return yaml.load(file);
  } catch (e) {
    console.warn('⚠️  Could not load severity-rules.yml, using defaults.');
    return {
      blocking: ['security', 'business_logic'],
      warnings: ['code_quality', 'performance'],
      info: ['style', 'naming'],
    };
  }
}

module.exports = { loadConfig };
