const fs = require('fs');

const owner = process.env.REPO_OWNER;
const repo = process.env.REPO_NAME;
const pullNumber = process.env.PR_NUMBER;
const baseSha = process.env.BASE_SHA;

async function githubRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status}: ${body}`);
  }

  return response.json();
}

async function paginate(url) {
  const items = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API ${response.status}: ${body}`);
    }

    items.push(...(await response.json()));
    const link = response.headers.get('link') || '';
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = match ? match[1] : null;
  }

  return items;
}

function decodeContent(response) {
  if (!response || !response.content) return null;
  return Buffer.from(response.content, 'base64').toString('utf8');
}

async function fetchRepoFile(filePath, ref) {
  const response = await githubRequest(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`
  );
  return decodeContent(response);
}

function readLocalFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function parseConfigModules(configPhp) {
  if (!configPhp) return new Set();
  const modules = new Set();
  const regex = /['"]([A-Za-z0-9]+_[A-Za-z0-9_]+)['"]\s*=>\s*1/g;
  let match;
  while ((match = regex.exec(configPhp)) !== null) {
    modules.add(match[1]);
  }
  return modules;
}

function upperCamel(part) {
  return part
    .split(/[-_]/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('');
}

function deriveModuleNameFromPackage(pkg) {
  const psr4 = pkg.autoload && pkg.autoload['psr-4'];
  if (psr4) {
    for (const namespace of Object.keys(psr4)) {
      const segments = namespace.replace(/\\+$/, '').split('\\').filter(Boolean);
      if (segments.length >= 2) {
        return `${segments[0]}_${segments[1]}`;
      }
    }
  }

  if (!pkg.name) return null;
  const [vendor, packageName] = pkg.name.split('/');
  if (!vendor || !packageName) return null;

  const cleanedPackage = packageName
    .replace(/^magento2-/, '')
    .replace(/^module-/, '')
    .replace(/^extension-/, '');

  return `${upperCamel(vendor)}_${upperCamel(cleanedPackage)}`;
}

function hasRegistrationEvidence(pkg) {
  const files = (pkg.autoload && pkg.autoload.files) || [];
  if (files.some((file) => /registration\.php$/i.test(file))) {
    return true;
  }

  return ['magento2-module', 'magento-module'].includes(pkg.type);
}

function collectLocalModules(files) {
  const modules = new Set();
  for (const file of files) {
    if (file.status !== 'added') continue;
    const match = file.filename.match(/^app\/code\/([^/]+)\/([^/]+)\/(?:etc\/module\.xml|registration\.php)$/);
    if (!match) continue;
    modules.add(`${match[1]}_${match[2]}`);
  }
  return [...modules];
}

async function collectComposerModules(files) {
  const composerTouched = files.some(
    (file) => file.filename === 'composer.lock' || file.filename === 'composer.json'
  );
  if (!composerTouched) return [];

  const headLock = readLocalFile('composer.lock');
  const baseLock = await fetchRepoFile('composer.lock', baseSha);
  if (!headLock || !baseLock) return [];

  const headPackages = [
    ...(JSON.parse(headLock).packages || []),
    ...(JSON.parse(headLock)['packages-dev'] || []),
  ];
  const basePackages = [
    ...(JSON.parse(baseLock).packages || []),
    ...(JSON.parse(baseLock)['packages-dev'] || []),
  ];

  const baseNames = new Set(basePackages.map((pkg) => pkg.name));
  return headPackages
    .filter((pkg) => !baseNames.has(pkg.name))
    .filter((pkg) => hasRegistrationEvidence(pkg))
    .map((pkg) => ({
      packageName: pkg.name,
      moduleName: deriveModuleNameFromPackage(pkg),
      hasRegistrationEvidence: hasRegistrationEvidence(pkg),
    }))
    .filter((pkg) => pkg.moduleName);
}

function emitError(message, file = 'app/etc/config.php', line = 1) {
  console.log(`::error file=${file},line=${line},title=Magento Module Registration::${message}`);
}

async function main() {
  const files = await paginate(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/files?per_page=100`
  );

  const configPhp = readLocalFile('app/etc/config.php');
  const enabledModules = parseConfigModules(configPhp);

  const failures = [];
  for (const moduleName of collectLocalModules(files)) {
    if (!enabledModules.has(moduleName)) {
      failures.push(
        `Local module ${moduleName} was added under app/code but is missing from app/etc/config.php.`
      );
    }
  }

  const composerModules = await collectComposerModules(files);
  for (const moduleInfo of composerModules) {
    if (!moduleInfo.hasRegistrationEvidence && !enabledModules.has(moduleInfo.moduleName)) {
      failures.push(
        `Composer package ${moduleInfo.packageName} appears to add Magento module ${moduleInfo.moduleName}, but no registration evidence was found and app/etc/config.php does not enable it.`
      );
    }
  }

  if (failures.length === 0) {
    console.log('Magento module registration check passed.');
    return;
  }

  failures.forEach((failure) => emitError(failure));
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
