# Windows packaging and maintenance

[简体中文](windows-packaging.zh-CN.md) · [Documentation index](../README.md)

## Build surface and prerequisite

The current packaging target is Windows x64. The [builder configuration](../../apps/desktop/electron-builder.config.ts) uses Electron `44.5.1` and a per-user NSIS installer. The installer permits choosing a directory, does not request elevation, does not automatically launch after installation, and retains application data on uninstall. Current configuration disables executable signing; do not describe the resulting build as signed.

The declared [managed subagent patch](../../patches/@tintinweb%252Fpi-subagents@0.19.0.patch) for `@tintinweb/pi-subagents@0.19.0` is tracked. Keep the patch and lockfile together for installation. A populated developer environment or the patch being present does not certify clean dependency installation, a reproducible build or clean-machine acceptance.

After dependencies and build prerequisites are available:

```powershell
bun run build:desktop
bun run package:desktop
```

The [build script](../../apps/desktop/build.ts) prepares desktop code, production runtime resources and bundled tools. Electron-builder reads `.build/package-app` and `.build/package-resources/medclaw`; installer output is under `.build/installers`. Runtime-resource preparation can require network access. Build files and installers are local outputs, not business-data backups.

## Runtime versions and upgrades

| Contract | Current value |
| --- | --- |
| Host protocol | `medclaw.host/p17-v3` |
| Database schema | `17` |
| Pi SDK / managed subagent plugin | `0.87.1` / `0.19.0` |

The installation manifest, desktop and Host must agree on the current protocol and schema. Schema 17 removes the database's single-child index; product admission enforces the four-owned-child limit and required save/release checks. See [the migration](../../packages/storage/src/migrations/017_subagent_parallel.sql) and [subagent behavior](../agents/subagents.md). Preserve a verified backup before upgrading a valuable data root, and use a compatible installation for that root.

Saved restore records accept protocol `p17-v1` or `p17-v2` with schema 16 as well as current records. This preserves the identity of an already completed restore; it does not negotiate an old active Host protocol. Whether an older backup can be restored is decided separately by snapshot validation. Sources: [protocol contracts](../../packages/contracts/src/protocol.ts), [maintenance contracts](../../packages/contracts/src/maintenance.ts).

The package includes built-in roles under `resources/subagents/` and delegation templates under `resources/subagent-prompts/`. User role overrides live under the selected writable data root; installation resources and user overrides have different ownership. See [role management](../agents/subagents.md#manage-role-files).

## Host ownership and shutdown

Main starts and supervises its controlled Bun Host. Each data root has writer ownership checks. A live process, necessary persistence, database closure and process-tree stop have separate facts; an exited parent alone does not certify that all descendants stopped.

When shutdown or ownership is unresolved, preserve the reported failure or unknown state. Do not clear a writer lock or resend a maintenance operation merely to make the UI appear ready. Use supported diagnostic and recovery controls. Sources: [Host controller](../../apps/desktop/src/main/host-controller.ts), [writer lock](../../apps/host/src/writer-lock.ts), [maintenance contracts](../../packages/contracts/src/maintenance.ts).

## Backup and restore

Use the desktop maintenance controls and their explicit source/destination selections. Backup requires the necessary clean-stop and persistence checks. Restore uses an independent new target root rather than silently overwriting a live root. Confirm the returned operation receipt and the resulting state separately from request submission.

An unknown maintenance result should be read back by its operation identity where supported; do not automatically repeat it. Treat backups as private material that may contain business state and protected configuration. Do not assume saved credentials are portable between machines or users without validating the supported restore behavior.

Sources: [maintenance controller](../../apps/desktop/src/main/maintenance-controller.ts), [backup implementation](../../packages/storage/src/backup.ts), [settings UI](../../apps/desktop/src/renderer/settings-page.tsx).

## Release verification

Record the actual scope of checks: types and relevant engineering tests; package resource and native dependency presence; clean Windows installation and launch; model configuration and real queries; restart with the same data root; controlled exit; backup, restore and unknown-result recovery; uninstall data retention.

Real provider/model behavior, signing and clean-machine readiness require their own evidence. The current documentation does not certify them from a successful development run. See [development checks](../development/contributing.md), [evaluation](../evaluation/overview.md), and [current product limits](../product/overview.md).
