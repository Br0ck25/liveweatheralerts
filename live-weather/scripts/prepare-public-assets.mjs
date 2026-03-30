import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(scriptDir, '..');
const frontendDistDir = resolve(workerDir, '..', 'frontend', 'dist');
const imagesDir = resolve(workerDir, 'images');
const publicAssetsDir = resolve(workerDir, 'public-assets');

if (!existsSync(frontendDistDir)) {
	throw new Error(`Frontend build output not found at ${frontendDistDir}. Run the frontend build first.`);
}

if (!existsSync(imagesDir)) {
	throw new Error(`Worker image directory not found at ${imagesDir}.`);
}

mkdirSync(publicAssetsDir, { recursive: true });
for (const entry of readdirSync(publicAssetsDir)) {
	rmSync(resolve(publicAssetsDir, entry), {
		recursive: true,
		force: true,
		maxRetries: 10,
		retryDelay: 150,
	});
}

cpSync(frontendDistDir, publicAssetsDir, { recursive: true });
cpSync(imagesDir, resolve(publicAssetsDir, 'images'), { recursive: true });

console.log(`Prepared public assets in ${publicAssetsDir}`);
