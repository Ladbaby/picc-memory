import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getClaudeMemorySourceDir } from "./paths.js";
function dirHasFiles(dir: string): boolean {
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isFile()) return true;
		}
	} catch {
	}
	return false;
}
function copyDirRecursive(srcDir: string, destDir: string): number {
	let count = 0;
	try {
		for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
			const srcPath = join(srcDir, entry.name);
			const destPath = join(destDir, entry.name);
			try {
				if (entry.isDirectory()) {
					count += copyDirRecursive(srcPath, destPath);
				} else if (entry.isFile()) {
					if (!existsSync(destPath)) {
						mkdirSync(dirname(destPath), { recursive: true });
						copyFileSync(srcPath, destPath);
						count++;
					}
				}
			} catch {
			}
		}
	} catch {
	}
	return count;
}
export function autoImportMemoryIfEmpty(destDir: string, cwd: string): number {
	const sourceDir = getClaudeMemorySourceDir(cwd);
	if (sourceDir === destDir) return 0;
	if (dirHasFiles(destDir)) return 0;
	if (!existsSync(sourceDir) || !dirHasFiles(sourceDir)) return 0;
	mkdirSync(destDir, { recursive: true });
	return copyDirRecursive(sourceDir, destDir);
}
export { getClaudeMemorySourceDir };
