import { memoryAdapter, schemaAdapter } from "@euroclaw/storage-core";
import { describe, expect, it } from "vitest";
import { skillsSchema } from "../src/core/index";
import { createGovernedSkillsApi, createSkillsStore } from "../src/index";

// Stores take the schema-aware adapter the assembly provides; tests wrap manually.
const db = () => schemaAdapter(memoryAdapter(), skillsSchema);

describe("@euroclaw/skills (governed)", () => {
	it("creates a nested skills API over a SkillsStore", async () => {
		const store = createSkillsStore(db(), {
			now: () => "2026-01-01T00:00:00.000Z",
		});
		const api = createGovernedSkillsApi(store);

		const pkg = await api.packages.create({
			packageId: "builtin.summarize-thread",
			version: "1.0.0",
			digest: "sha256:abc",
			manifest: {
				id: "summarize-thread",
				description: "Summarize a thread",
				allowedTools: ["summarize"],
			},
			source: "builtin",
		});
		expect(await api.packages.get({ id: pkg.id })).toMatchObject({
			packageId: "builtin.summarize-thread",
		});

		const installation = await api.installations.create({
			packageId: pkg.packageId,
			version: pkg.version,
			digest: pkg.digest,
			organizationId: "organization-1",
		});
		expect(
			await api.installations.updateStatus({
				id: installation.id,
				patch: { status: "enabled", enabledBy: "admin-1" },
			}),
		).toMatchObject({ status: "enabled" });
	});

	it("hardens package manifests created through the skills API", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()));

		await expect(
			api.packages.create({
				packageId: "team.bad-skill",
				version: "1.0.0",
				digest: "sha256:bad-skill",
				manifest: {
					id: "Bad Skill",
					description: "Bad skill",
					allowedTools: ["send_email"],
				},
				source: "upload",
			}),
		).rejects.toThrow(/id must be matched by/);
	});

	it("returns compact installed catalog entries scoped by organization", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()));
		const pkg = await api.packages.create({
			packageId: "team.email-only",
			version: "1.0.0",
			digest: "sha256:catalog",
			manifest: {
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
			},
			publisher: "team-1",
			source: "upload",
		});
		await api.install({
			packageId: pkg.packageId,
			organizationId: "organization-1",
			version: pkg.version,
			visibility: "team",
		});

		await expect(
			api.catalog({
				includeStatic: false,
				publisher: "team-1",
				source: "upload",
				status: "installed",
				organizationId: "organization-1",
				visibility: "team",
			}),
		).resolves.toEqual([
			expect.objectContaining({
				allowedTools: ["send_email"],
				description: "Email only",
				digest: pkg.digest,
				id: "email-only",
				kind: "installed",
				packageId: pkg.packageId,
				publisher: "team-1",
				source: "upload",
				status: "installed",
				organizationId: "organization-1",
				version: pkg.version,
				visibility: "team",
			}),
		]);
		const [entry] = await api.catalog({
			includeStatic: false,
			organizationId: "organization-1",
		});
		expect("instructions" in entry).toBe(false);
		await expect(
			api.catalog({ organizationId: "organization-2" }),
		).resolves.toEqual([]);
	});

	it("reads personal DB-backed skills and persists read records", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()), {
			readContext: {
				readBy: "actor-1",
				organizationId: "organization-1",
			},
		});
		const personal = await api.createPersonal({
			digest: "sha256:read-personal",
			manifest: {
				id: "read-personal",
				description: "Read personal",
				allowedTools: ["send_email"],
			},
			ownerActorId: "actor-1",
			packageId: "actor-1.read-personal",
			organizationId: "organization-1",
			version: "1.0.0",
		});

		const read = await api.read({
			clawId: "claw-1",
			installationId: personal.installation.id,
			runId: "run-1",
			source: "user",
			threadId: "thread-1",
		});
		expect(read).toMatchObject({
			id: "read-personal",
			installation: { id: personal.installation.id, status: "enabled" },
			kind: "installed",
			read: {
				readBy: "actor-1",
				runId: "run-1",
				skillId: "read-personal",
				organizationId: "organization-1",
				threadId: "thread-1",
			},
		});
		await expect(api.reads.get({ id: read.read.id })).resolves.toMatchObject({
			skillId: "read-personal",
		});
		await expect(api.reads.listForRun({ runId: "run-1" })).resolves.toEqual([
			read.read,
		]);
		await expect(
			api.reads.listForThread({ threadId: "thread-1" }),
		).resolves.toEqual([read.read]);
		await expect(api.read({ id: "read-personal" })).resolves.toMatchObject({
			id: "read-personal",
			kind: "installed",
		});
	});

	it("records static skill reads when a store and read context are available", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()), {
			readContext: {
				readBy: "actor-1",
				organizationId: "organization-1",
			},
			staticSkills: [
				{
					id: "static-read",
					description: "Static read",
					allowedTools: ["send_email"],
				},
			],
		});

		const result = await api.read({
			id: "static-read",
			runId: "run-static",
			threadId: "thread-static",
		});
		expect(result).toMatchObject({
			id: "static-read",
			kind: "static",
			manifest: { description: "Static read" },
			read: {
				readBy: "actor-1",
				runId: "run-static",
				skillId: "static-read",
				organizationId: "organization-1",
				threadId: "thread-static",
			},
		});
		await expect(
			api.reads.listForRun({ runId: "run-static" }),
		).resolves.toEqual([result.read]);
	});

	it("requires trusted read context and read ACL for DB-backed skills", async () => {
		const store = createSkillsStore(db());
		const apiWithoutContext = createGovernedSkillsApi(store);
		const api = createGovernedSkillsApi(store, {
			readContext: {
				readBy: "actor-1",
				organizationId: "organization-1",
			},
		});
		const pkg = await api.packages.create({
			packageId: "team.read-locked",
			version: "1.0.0",
			digest: "sha256:read-locked",
			manifest: {
				id: "read-locked",
				description: "Read locked",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});
		const installation = await api.install({
			packageId: pkg.packageId,
			organizationId: "organization-1",
			version: pkg.version,
		});
		await api.trustInstallation({
			installationId: installation.id,
			organizationId: "organization-1",
			trustedBy: "admin-1",
		});
		await api.enableInstallation({
			enabledBy: "admin-1",
			installationId: installation.id,
			organizationId: "organization-1",
		});

		await expect(
			apiWithoutContext.read({ installationId: installation.id }),
		).rejects.toThrow(/requires readContext/);
		await expect(api.read({ installationId: installation.id })).rejects.toThrow(
			/actor cannot read this skill/,
		);
		await api.acl.grant({
			installationId: installation.id,
			permission: "read",
			principalId: "actor-1",
			principalType: "actor",
			organizationId: "organization-1",
		});
		await expect(
			api.read({ installationId: installation.id }),
		).resolves.toMatchObject({
			id: "read-locked",
			manifest: { description: "Read locked" },
		});
	});

	it("rejects reads for unavailable installed skills", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()), {
			readContext: {
				readBy: "actor-1",
				organizationId: "organization-1",
			},
		});
		const pkg = await api.packages.create({
			packageId: "team.not-ready",
			version: "1.0.0",
			digest: "sha256:not-ready",
			manifest: {
				id: "not-ready",
				description: "Not ready",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});
		const installation = await api.install({
			packageId: pkg.packageId,
			organizationId: "organization-1",
			version: pkg.version,
		});
		await api.acl.grant({
			installationId: installation.id,
			permission: "read",
			principalId: "actor-1",
			principalType: "actor",
			organizationId: "organization-1",
		});

		await expect(api.read({ installationId: installation.id })).rejects.toThrow(
			/not enabled or trusted/,
		);
	});

	it("creates private personal skills", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()));

		const result = await api.createPersonal({
			digest: "sha256:personal",
			manifest: {
				id: "personal",
				description: "Personal workflow",
				allowedTools: ["send_email"],
			},
			ownerActorId: "actor-1",
			packageId: "actor-1.personal",
			organizationId: "organization-1",
			version: "1.0.0",
		});

		expect(result.package).toMatchObject({
			publisher: "actor-1",
			source: "local",
		});
		expect(result.installation).toMatchObject({
			enabledBy: "actor-1",
			ownerActorId: "actor-1",
			status: "enabled",
			organizationId: "organization-1",
			visibility: "private",
		});
		expect(result.grant).toMatchObject({
			installationId: result.installation.id,
			permission: "activate",
			principalId: "actor-1",
			principalType: "actor",
		});
		expect(result.readGrant).toMatchObject({
			installationId: result.installation.id,
			permission: "read",
			principalId: "actor-1",
			principalType: "actor",
		});
		await expect(
			api.acl.listForInstallation({
				installationId: result.installation.id,
			}),
		).resolves.toEqual([result.grant, result.readGrant]);
	});

	it("proposes sharing until approved, then grants", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()));
		const personal = await api.createPersonal({
			digest: "sha256:governed-share",
			manifest: {
				id: "governed-share",
				description: "Governed share",
				allowedTools: ["send_email"],
			},
			ownerActorId: "actor-1",
			packageId: "actor-1.governed-share",
			organizationId: "organization-1",
			version: "1.0.0",
		});

		// Without an approver, a share is recorded as a proposal awaiting review.
		await expect(
			api.share({
				installationId: personal.installation.id,
				principalId: "team-1",
				principalType: "team",
				reason: "share with hiring team",
				requestedBy: "actor-1",
				organizationId: "organization-1",
			}),
		).resolves.toMatchObject({
			proposal: {
				kind: "share",
				proposerActorId: "actor-1",
				state: expect.objectContaining({
					installationId: personal.installation.id,
					permission: "activate",
					principalId: "team-1",
					principalType: "team",
				}),
				targetInstallationId: personal.installation.id,
			},
			status: "proposed",
		});
		await expect(
			api.acl.listForInstallation({
				installationId: personal.installation.id,
			}),
		).resolves.toHaveLength(2);

		// An explicit approver short-circuits straight to the grant.
		await expect(
			api.share({
				approvedBy: "admin-1",
				installationId: personal.installation.id,
				principalId: "team-1",
				principalType: "team",
				requestedBy: "actor-1",
				organizationId: "organization-1",
			}),
		).resolves.toMatchObject({
			grant: {
				installationId: personal.installation.id,
				permission: "activate",
				principalId: "team-1",
				principalType: "team",
			},
			status: "granted",
		});
	});

	it("requestShare always records a share proposal", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()));
		const personal = await api.createPersonal({
			digest: "sha256:request-share",
			manifest: {
				id: "request-share",
				description: "Request share",
				allowedTools: ["send_email"],
			},
			ownerActorId: "actor-1",
			packageId: "actor-1.request-share",
			organizationId: "organization-1",
			version: "1.0.0",
		});

		await expect(
			api.requestShare({
				installationId: personal.installation.id,
				principalType: "public",
				requestedBy: "actor-1",
				organizationId: "organization-1",
			}),
		).resolves.toMatchObject({
			kind: "share",
			state: expect.objectContaining({
				permission: "activate",
				principalType: "public",
			}),
			targetInstallationId: personal.installation.id,
		});
	});

	it("validates share principals before writing grants or proposals", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()));
		const personal = await api.createPersonal({
			digest: "sha256:bad-share",
			manifest: {
				id: "bad-share",
				description: "Bad share",
				allowedTools: ["send_email"],
			},
			ownerActorId: "actor-1",
			packageId: "actor-1.bad-share",
			organizationId: "organization-1",
			version: "1.0.0",
		});

		await expect(
			api.share({
				installationId: personal.installation.id,
				principalId: "actor-2",
				principalType: "public",
				requestedBy: "actor-1",
				organizationId: "organization-1",
			}),
		).rejects.toThrow(/principalId must be undefined/);
		await expect(
			api.requestShare({
				installationId: personal.installation.id,
				principalType: "team",
				requestedBy: "actor-1",
				organizationId: "organization-1",
			}),
		).rejects.toThrow(/principalId must be a string/);
	});

	it("installs packages through the lifecycle helper", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()));
		const pkg = await api.packages.create({
			packageId: "team.email-only",
			version: "1.0.0",
			digest: "sha256:install",
			manifest: {
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});

		await expect(
			api.install({
				packageId: pkg.packageId,
				organizationId: "organization-1",
				version: pkg.version,
				visibility: "team",
			}),
		).resolves.toMatchObject({
			digest: pkg.digest,
			packageId: pkg.packageId,
			status: "installed",
			organizationId: "organization-1",
			version: pkg.version,
			visibility: "team",
		});
	});

	it("rejects installs without matching packages", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()));

		await expect(
			api.install({
				packageId: "team.missing",
				organizationId: "organization-1",
				version: "1.0.0",
			}),
		).rejects.toThrow(/skill package not found/);
	});

	it("enforces trust and enable transitions", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()));
		const pkg = await api.packages.create({
			packageId: "team.email-only",
			version: "1.0.0",
			digest: "sha256:lifecycle",
			manifest: {
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});
		const installation = await api.install({
			packageId: pkg.packageId,
			organizationId: "organization-1",
			version: pkg.version,
		});

		await expect(
			api.enableInstallation({
				enabledBy: "admin-1",
				installationId: installation.id,
				organizationId: "organization-1",
			}),
		).rejects.toThrow(/must be trusted/);
		const trusted = await api.trustInstallation({
			installationId: installation.id,
			organizationId: "organization-1",
			trustedBy: "admin-1",
		});
		expect(trusted).toMatchObject({
			status: "trusted",
			trustedBy: "admin-1",
		});
		await expect(
			api.enableInstallation({
				enabledBy: "admin-1",
				installationId: installation.id,
				organizationId: "organization-1",
			}),
		).resolves.toMatchObject({ enabledBy: "admin-1", status: "enabled" });
	});

	it("checks activation grants before writing ACL records", async () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()));
		const pkg = await api.packages.create({
			packageId: "team.email-only",
			version: "1.0.0",
			digest: "sha256:grant",
			manifest: {
				id: "email-only",
				description: "Email only",
				allowedTools: ["send_email"],
			},
			source: "upload",
		});
		const installation = await api.install({
			packageId: pkg.packageId,
			organizationId: "organization-1",
			version: pkg.version,
		});

		await expect(
			api.grantActivation({
				installationId: installation.id,
				principalId: "actor-1",
				principalType: "public",
				organizationId: "organization-1",
			}),
		).rejects.toThrow(/principalId must be undefined/);
		await expect(
			api.grantActivation({
				installationId: installation.id,
				principalType: "actor",
				organizationId: "organization-1",
			}),
		).rejects.toThrow(/principalId must be a string/);
		await expect(
			api.grantActivation({
				installationId: installation.id,
				principalId: "actor-1",
				principalType: "actor",
				organizationId: "organization-2",
			}),
		).rejects.toThrow(/installation not found/);
		await expect(
			api.grantActivation({
				installationId: installation.id,
				principalId: "actor-1",
				principalType: "actor",
				organizationId: "organization-1",
			}),
		).resolves.toMatchObject({
			installationId: installation.id,
			permission: "activate",
			principalId: "actor-1",
			principalType: "actor",
		});
	});

	it("does not expose raw activation creation on the public skills API", () => {
		const api = createGovernedSkillsApi(createSkillsStore(db()));

		expect("create" in api.activations).toBe(false);
	});
});
