import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, sep } from "node:path";
const AUTO_MEM_DIRNAME = "memory";
const AUTO_MEM_ENTRYPOINT_NAME = "MEMORY.md";
const MAX_SANITIZED_LENGTH = 200;
const ENV_PICC_REMOTE_MEMORY_DIR = "PICC_REMOTE_MEMORY_DIR";
const ENV_CC_REMOTE_MEMORY_DIR = "CLAUDE_CODE_REMOTE_MEMORY_DIR";
const ENV_CC_COWORK_OVERRIDE = "CLAUDE_COWORK_MEMORY_PATH_OVERRIDE";
const ENV_CC_CONFIG_DIR = "CLAUDE_CONFIG_DIR";
const ENV_PICC_MEMORY_CONFIG_PATH = "PICC_MEMORY_CONFIG_PATH";
const GIT_ROOT_TIMEOUT_MS = 5_000;
const ENV_DISABLE_PICC = "PICC_DISABLE_AUTO_MEMORY";
const ENV_DISABLE_CC = "CLAUDE_CODE_DISABLE_AUTO_MEMORY";
const ENV_EXTRA_PICC = "PICC_MEMORY_EXTRA_GUIDELINES";
const ENV_EXTRA_CC = "CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES";
export function isEnvTruthy(v: string | undefined): boolean {
	return typeof v === "string" && /^(1|true|yes)$/i.test(v.trim());
}
export function isEnvDefinedFalsy(v: string | undefined): boolean {
	return typeof v === "string" && /^(0|false|no)$/i.test(v.trim());
}
export function readExtraGuidelines(): string[] | undefined {
	const local = process.env[ENV_EXTRA_PICC]?.trim();
	if (local) return [local];
	const cowork = process.env[ENV_EXTRA_CC]?.trim();
	if (cowork) return [cowork];
	return undefined;
}
export function isAutoMemoryEnabled(): boolean {
	const picc = process.env[ENV_DISABLE_PICC];
	if (isEnvTruthy(picc)) return false;
	if (isEnvDefinedFalsy(picc)) return true;
	const cc = process.env[ENV_DISABLE_CC];
	if (isEnvTruthy(cc)) return false;
	if (isEnvDefinedFalsy(cc)) return true;
	return true;
}
export function getMemoryBaseDir(): string {
	return join(getAgentDir(), "extensions", "picc-memory") + sep;
}
export function getClaudeConfigHomeDir(): string {
	return process.env[ENV_CC_CONFIG_DIR] ?? join(homedir(), ".claude");
}
function djb2Hash(s: string): number {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
	return h;
}
function sanitizePath(rawPath: string): string {
	const sanitized = rawPath.replace(/[^a-zA-Z0-9]/g, "-");
	if (sanitized.length <= MAX_SANITIZED_LENGTH) {
		return sanitized;
	}
	return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2Hash(rawPath)).toString(36)}`;
}
export function validateMemoryPath(raw: string | undefined, expandTilde = false): string | undefined {
	if (!raw) return undefined;
	let candidate = raw;
	if (expandTilde && (candidate.startsWith("~/") || candidate.startsWith("~\\"))) {
		const rest = candidate.slice(2);
		const restNorm = normalize(rest || ".");
		if (restNorm === "." || restNorm === "..") {
			return undefined;
		}
		candidate = join(homedir(), rest);
	}
	const normalized = normalize(candidate).replace(/[/\\]+$/, "");
	if (
		!isAbsolute(normalized) ||
		normalized.length < 3 ||
		/^[A-Za-z]:$/.test(normalized) ||
		normalized.startsWith("\\\\") ||
		normalized.startsWith("//") ||
		normalized.includes("\0")
	) {
		return undefined;
	}
	return (normalized + sep).normalize("NFC");
}
function findCanonicalGitRoot(cwd: string): string | null {
	try {
		const result = execSync("git rev-parse --show-toplevel", {
			cwd,
			encoding: "utf-8",
			timeout: GIT_ROOT_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const trimmed = result.trim();
		return trimmed ? normalize(trimmed) : null;
	} catch {
		return null;
	}
}
function getAutoMemBase(cwd: string): string {
	return findCanonicalGitRoot(cwd) ?? normalize(cwd);
}
type MemoryConfig = { autoMemoryDirectory?: string };
function readJsonConfig(path: string): MemoryConfig {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (parsed && typeof parsed === "object") return parsed as MemoryConfig;
		return {};
	} catch {
		return {};
	}
}
export function getPiccMemoryConfigPath(): string {
	return (
		process.env[ENV_PICC_MEMORY_CONFIG_PATH] ??
		join(getAgentDir(), "extensions", "picc-memory", "config.json")
	);
}
export function readPiccMemoryConfig(): MemoryConfig {
	return readJsonConfig(getPiccMemoryConfigPath());
}
export function readClaudeMemoryConfig(): MemoryConfig {
	const path = join(getClaudeConfigHomeDir(), "settings.json");
	return existsSync(path) ? readJsonConfig(path) : {};
}
export function getClaudeMemorySourceDir(cwd: string): string {
	const sanitized = sanitizePath(getAutoMemBase(cwd));
	const fromCowork = mapToMemDir(process.env[ENV_CC_COWORK_OVERRIDE], sanitized, true);
	if (fromCowork) return fromCowork;
	const fromSetting = mapToMemDir(readClaudeMemoryConfig().autoMemoryDirectory, sanitized, true);
	if (fromSetting) return fromSetting;
	const base = validateMemoryPath(process.env[ENV_CC_REMOTE_MEMORY_DIR], false) ?? getClaudeConfigHomeDir() + sep;
	return (join(base, "projects", sanitized, AUTO_MEM_DIRNAME) + sep).normalize("NFC");
}
function mapToMemDir(raw: string | undefined, sanitized: string, full: boolean): string | undefined {
	const validated = validateMemoryPath(raw, full);
	if (!validated) return undefined;
	if (full) return validated;
	return join(validated, "projects", sanitized, AUTO_MEM_DIRNAME) + sep;
}
const autoMemPathCache = new Map<string, string>();
export function getAutoMemPath(cwd: string): string {
	const cached = autoMemPathCache.get(cwd);
	if (cached !== undefined) return cached;
	const sanitized = sanitizePath(getAutoMemBase(cwd));
	const result =
		mapToMemDir(process.env[ENV_PICC_REMOTE_MEMORY_DIR], sanitized, false) ??
		mapToMemDir(readPiccMemoryConfig().autoMemoryDirectory, sanitized, true) ??
		mapToMemDir(process.env[ENV_CC_REMOTE_MEMORY_DIR], sanitized, false) ??
		mapToMemDir(readClaudeMemoryConfig().autoMemoryDirectory, sanitized, true) ??
		join(getMemoryBaseDir(), "projects", sanitized, AUTO_MEM_DIRNAME) + sep;
	const normalized = (normalize(result) + sep).normalize("NFC");
	autoMemPathCache.set(cwd, normalized);
	return normalized;
}
export function getAutoMemEntrypoint(cwd: string): string {
	return join(getAutoMemPath(cwd), AUTO_MEM_ENTRYPOINT_NAME);
}
export function isAutoMemPath(absolutePath: string, cwd: string): boolean {
	try {
		const validated = validateMemoryPath(absolutePath, false);
		const candidate = validated ?? normalize(absolutePath);
		return candidate.startsWith(getAutoMemPath(cwd));
	} catch {
		return false;
	}
}
export function clearAutoMemPathCache(): void {
	autoMemPathCache.clear();
}
function getManagedClaudeMdPath(): string | undefined {
	if (process.platform === "win32") {
		const winPath = join(
			process.env.ProgramData ?? "C:\\ProgramData",
			"claude-code",
			"CLAUDE.md",
		);
		return existsSync(winPath) ? winPath : undefined;
	}
	const unixPath = "/etc/claude-code/CLAUDE.md";
	return existsSync(unixPath) ? unixPath : undefined;
}
function getManagedClaudeRulesDir(): string | undefined {
	if (process.platform === "win32") {
		const winPath = join(
			process.env.ProgramData ?? "C:\\ProgramData",
			"claude-code",
			"rules",
		);
		return existsSync(winPath) ? winPath : undefined;
	}
	const unixPath = "/etc/claude-code/rules";
	return existsSync(unixPath) ? unixPath : undefined;
}
function getUserClaudeMdPath(): string {
	return join(getClaudeConfigHomeDir(), "CLAUDE.md");
}
function getUserClaudeRulesDir(): string {
	return join(getClaudeConfigHomeDir(), "rules");
}
export function isSymlink(filePath: string): boolean {
	try {
		return lstatSync(filePath).isSymbolicLink();
	} catch {
		return false;
	}
}
export {
	getManagedClaudeMdPath,
	getManagedClaudeRulesDir,
	getUserClaudeMdPath,
	getUserClaudeRulesDir,
	findCanonicalGitRoot,
};
export const _isAbsolute = isAbsolute;
