import { describe, expect, it, vi } from "vitest";
import {
	assertEgressAllowed,
	blockedAddressReason,
	type EgressLookup,
} from "../src/tools/egress";

/** A fake resolver returning fixed addresses — no real DNS in tests. */
const lookupReturning =
	(...addresses: string[]): EgressLookup =>
	async () =>
		addresses.map((address) => ({
			address,
			family: address.includes(":") ? 6 : 4,
		}));

describe("blockedAddressReason — the range floor", () => {
	it("blocks every private / loopback / link-local / CGNAT / unspecified IPv4 range", () => {
		expect(blockedAddressReason("127.0.0.1")).toMatch(/loopback/);
		expect(blockedAddressReason("10.1.2.3")).toMatch(/private/);
		expect(blockedAddressReason("172.16.0.1")).toMatch(/private/);
		expect(blockedAddressReason("172.31.255.255")).toMatch(/private/);
		expect(blockedAddressReason("192.168.1.1")).toMatch(/private/);
		expect(blockedAddressReason("169.254.1.1")).toMatch(/link-local/);
		expect(blockedAddressReason("100.64.0.1")).toMatch(/CGNAT/);
		expect(blockedAddressReason("0.0.0.0")).toMatch(/unspecified/);
	});

	it("allows public IPv4 and the boundaries just outside 172.16/12", () => {
		expect(blockedAddressReason("8.8.8.8")).toBeUndefined();
		expect(blockedAddressReason("172.15.0.1")).toBeUndefined();
		expect(blockedAddressReason("172.32.0.1")).toBeUndefined();
		expect(blockedAddressReason("93.184.216.34")).toBeUndefined();
	});

	it("blocks IPv6 loopback / link-local / unique-local / unspecified", () => {
		expect(blockedAddressReason("::1")).toMatch(/loopback/);
		expect(blockedAddressReason("fe80::1")).toMatch(/link-local/);
		expect(blockedAddressReason("fc00::1")).toMatch(/unique-local/);
		expect(blockedAddressReason("fd12:3456::1")).toMatch(/unique-local/);
		expect(blockedAddressReason("::")).toMatch(/unspecified/);
	});

	it("blocks IPv4-mapped IPv6 by validating the embedded IPv4 (dotted and hex forms)", () => {
		expect(blockedAddressReason("::ffff:127.0.0.1")).toMatch(/loopback/);
		expect(blockedAddressReason("::ffff:10.0.0.1")).toMatch(/private/);
		expect(blockedAddressReason("::ffff:7f00:1")).toMatch(/loopback/); // URL-normalized form
		expect(blockedAddressReason("::ffff:8.8.8.8")).toBeUndefined(); // mapped public → allowed
	});

	it("allows public IPv6", () => {
		expect(blockedAddressReason("2606:4700::1111")).toBeUndefined();
	});

	it("fails closed on an unparseable address", () => {
		expect(blockedAddressReason("not-an-ip")).toMatch(/unparseable/);
	});
});

describe("assertEgressAllowed", () => {
	it("blocks http unless allowInsecure is set", async () => {
		await expect(
			assertEgressAllowed("http://example.com/x", {
				lookup: lookupReturning("93.184.216.34"),
			}),
		).rejects.toThrow(/only https/);
		const ok = await assertEgressAllowed("http://example.com/x", {
			allowInsecure: true,
			lookup: lookupReturning("93.184.216.34"),
		});
		expect(ok.pinnedAddress).toBe("93.184.216.34");
	});

	it("allows a public https host and returns the pinned address", async () => {
		const decision = await assertEgressAllowed("https://api.example.com/v1", {
			lookup: lookupReturning("93.184.216.34"),
		});
		expect(decision.pinnedAddress).toBe("93.184.216.34");
		expect(decision.family).toBe(4);
		expect(decision.url).toBe("https://api.example.com/v1");
	});

	it("blocks a loopback IP-literal target without any DNS lookup", async () => {
		const lookup = vi.fn(lookupReturning("1.1.1.1"));
		await expect(
			assertEgressAllowed("https://127.0.0.1/x", { lookup }),
		).rejects.toThrow(/disallowed address/);
		expect(lookup).not.toHaveBeenCalled();
	});

	it("blocks a hostname that resolves into a private range (post-resolution)", async () => {
		await expect(
			assertEgressAllowed("https://intranet.example.com/x", {
				lookup: lookupReturning("10.0.0.5"),
			}),
		).rejects.toThrow(/disallowed address/);
	});

	it("blocks an IPv4-mapped IPv6 literal", async () => {
		await expect(
			assertEgressAllowed("https://[::ffff:127.0.0.1]/x"),
		).rejects.toThrow(/disallowed address/);
	});

	it("the pin IS the resolved address — resolved once, and that address is what is returned", async () => {
		const lookup = vi.fn(lookupReturning("93.184.216.34"));
		const decision = await assertEgressAllowed("https://api.example.com/x", {
			lookup,
		});
		expect(lookup).toHaveBeenCalledTimes(1); // no second resolution between check and pin
		expect(decision.pinnedAddress).toBe("93.184.216.34");
	});

	it("fails closed: if any resolved address is blocked, the whole target is refused", async () => {
		await expect(
			assertEgressAllowed("https://rebind.example.com/x", {
				lookup: lookupReturning("93.184.216.34", "10.0.0.1"),
			}),
		).rejects.toThrow(/disallowed address/);
	});
});
