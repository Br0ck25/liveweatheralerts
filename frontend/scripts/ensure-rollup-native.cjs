const { execSync } = require('child_process');
const { platform, arch } = process;

const platformMap = {
  'linux-x64': '@rollup/rollup-linux-x64-gnu',
  'linux-x64-musl': '@rollup/rollup-linux-x64-musl',
  'linux-arm64': '@rollup/rollup-linux-arm64-gnu',
  'linux-arm64-musl': '@rollup/rollup-linux-arm64-musl',
  'win32-x64': '@rollup/rollup-win32-x64-msvc',
  'win32-arm64': '@rollup/rollup-win32-arm64-msvc'
};

let key = `${platform}-${arch}`;
if (process.env.ROLLUP_LIBC === 'musl') {
  key += '-musl';
}

const pkgName = platformMap[key];
if (!pkgName) {
  console.log(`ensure-rollup-native: no native package for ${platform}/${arch}`);
  process.exit(0);
}

try {
  require(pkgName);
  console.log(`ensure-rollup-native: ${pkgName} already installed.`);
  process.exit(0);
} catch {
  console.log(`ensure-rollup-native: ${pkgName} missing; installing...`);
}

const version = '4.60.0';
try {
  execSync(`npm install --no-audit --no-fund --no-save ${pkgName}@${version}`, { stdio: 'inherit' });
  console.log(`ensure-rollup-native: installed ${pkgName}@${version}`);
} catch (error) {
  console.warn(`ensure-rollup-native: failed to install ${pkgName}; ${error.message}`);
  console.warn('If build still fails, install the correct native rollup optional dependency manually.');
}
