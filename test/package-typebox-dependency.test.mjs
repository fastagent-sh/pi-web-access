import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const { name: packageName } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

test("packed installs keep typebox as a peer dependency (hosted by pi at runtime)", async () => {
	const tempDir = await mkdtemp(join(tmpdir(), "pi-web-access-pack-install-"));
	try {
		const packOutput = execFileSync("npm", ["pack", "--json", "--pack-destination", tempDir], {
			cwd: repoRoot,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const [{ filename, files }] = JSON.parse(packOutput);
		const packedFiles = files.map((file) => file.path);
		assert.ok(packedFiles.includes("index.ts"));
		assert.ok(packedFiles.includes("CHANGELOG.md"));
		assert.ok(packedFiles.includes("SECURITY.md"));
		assert.ok(!packedFiles.some((path) => path.startsWith("skills/")));
		assert.ok(!packedFiles.some((path) => path.startsWith("test/")));
		// Pi installs packages without peers and hosts typebox itself, so the package must not ship a private copy.
		execFileSync("npm", ["install", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund", join(tempDir, filename)], {
			cwd: tempDir,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const packageRequire = createRequire(join(tempDir, "node_modules", packageName, "package.json"));
		const installedManifest = packageRequire(`${packageName}/package.json`);
		assert.equal(installedManifest.peerDependencies?.typebox, "*");
		assert.equal(installedManifest.dependencies?.typebox, undefined);
		assert.throws(() => packageRequire.resolve("typebox"), { code: "MODULE_NOT_FOUND" });
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
});
