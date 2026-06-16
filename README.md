# euroclaw

**A governed AI agent.**

> 🚀 **Public next week.**

euroclaw is an AI agent that's **governed by construction**: every action it takes — every
tool call, every model call — is **redacted**, **policy-gated**, and written to a
**tamper-evident audit trail**. It works on real people's data without ever holding the
sensitive parts in the clear.

Its governance core is **plugin-extensible**: compliance (EU GDPR + AI Act, HIPAA, …) is the
flagship *plugin*, **not** the product — you opt into the governance you need.

## What it does

- **Redact at the edge.** PII becomes placeholders the moment it arrives; the real values live
  in a vault and reattach only inside the tool that needs them. Erasing a person is one key
  delete — GDPR Article 17 as a primitive.
- **Gate every action.** A pipeline of checks runs before each tool or model call: permit,
  deny, or pause for a human. Your rules, your policy engine — the agent can't act around them.
- **Audit, tamper-evident.** Every decision lands in a hash-chained log (SHA-256 by default).
  Not "we have logs" — a record you can hand an auditor.

**Both boundaries** it acts through are governed: the tools it calls *and* the model it talks
to — the prompt is redacted before it ever leaves for the provider.

## Provable, not claimed

A compliance plugin can mark a gate **sealed**: the core guarantees it runs, and it **cannot
be removed, replaced, or bypassed** — the assembly refuses to start if something tries. That's
the difference between *claiming* a control is present and *proving* it to an auditor. The
provability is the moat.

## Run it anywhere

**One core, many forms.** The same governance ships as an **SDK**, a **local appliance**
(single binary), an **on-prem / microVM** image (isolated per tenant), or a **hosted** service.

## Is it GDPR compliant?

**Yes.**

*(Fine print, because we're that kind of project: euroclaw gives you provable, tamper-evident
enforcement — the part that's hard to fake. A lawyer and an auditor sign the certificate;
euroclaw makes sure there's something real to certify.)*

## License

MIT — see [LICENSE](LICENSE).
