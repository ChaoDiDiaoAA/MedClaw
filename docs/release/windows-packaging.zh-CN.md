# Windows 打包与维护

[English](windows-packaging.md) · [文档目录](../README.md)

## 构建入口与前置

当前打包目标为 Windows x64。[构建配置](../../apps/desktop/electron-builder.config.ts)使用 Electron `44.5.1` 与按用户安装的 NSIS 安装包，允许选择安装目录、不请求提权、不在安装后自动启动，并在卸载时保留应用数据。当前配置关闭可执行文件签名，不能把结果称为已签名构建。

项目声明的 `@tintinweb/pi-subagents@0.19.0` [受控子代理补丁](../../patches/@tintinweb%252Fpi-subagents@0.19.0.patch)已跟踪，安装时应与锁文件配套保留。现成开发环境或补丁存在不能证明干净依赖安装、可复现构建或干净机器验收通过。

依赖与构建前置可用后执行：

```powershell
bun run build:desktop
bun run package:desktop
```

[构建脚本](../../apps/desktop/build.ts)准备桌面代码、生产运行资源与随包工具。Electron-builder 读取 `.build/package-app` 和 `.build/package-resources/medclaw`，安装包输出到 `.build/installers`。运行资源准备可能需要网络，构建文件和安装包不是业务数据备份。

## 运行版本与升级

| 契约 | 当前值 |
| --- | --- |
| Host 协议 | `medclaw.host/p17-v3` |
| 数据库 Schema | `17` |
| Pi SDK / 受控子代理插件 | `0.87.1` / `0.19.0` |

安装清单、桌面与 Host 须使用一致的当前协议和 Schema。Schema 17 移除数据库的单子任务索引，由产品准入执行四个占用中子任务的上限及必要的保存、释放检查。参见[迁移](../../packages/storage/src/migrations/017_subagent_parallel.sql)和[子代理行为](../agents/subagents.zh-CN.md)。升级有价值的数据根前保留已核验备份，并使用与该数据根兼容的安装版本。

已保存的恢复记录可读取协议 `p17-v1`、`p17-v2` 与 Schema 16，以及当前版本记录，用于保留已经完成的恢复身份；活动 Host 仍使用当前协议。旧备份能否恢复应另按快照校验结果确认。源码：[协议契约](../../packages/contracts/src/protocol.ts)、[维护契约](../../packages/contracts/src/maintenance.ts)。

随包资源包含 `resources/subagents/` 内置角色与 `resources/subagent-prompts/` 委派模板，用户角色覆盖保存在所选可写数据根中。安装资源与用户覆盖有不同所有权，参见[角色管理](../agents/subagents.zh-CN.md#管理角色文件)。

## Host 所有权与退出

Main 启动并监督受控 Bun Host，每个数据根检查写入所有权。进程存在、必要保存、数据库关闭和进程树停止分别记录；父进程退出不等于所有后代均已停止。

退出或所有权无法确认时，保留失败或未知状态。不能为使界面显示就绪而清除写入锁或重发维护操作，应使用支持的诊断和恢复入口。源码：[Host 控制](../../apps/desktop/src/main/host-controller.ts)、[写入锁](../../apps/host/src/writer-lock.ts)、[维护契约](../../packages/contracts/src/maintenance.ts)。

## 备份与恢复

通过桌面维护入口明确选择源和目标。备份需要必要的清洁停写与保存确认，恢复使用独立新根，不静默覆盖活动根。请求提交、返回操作回执和最终结果状态分别确认。

维护结果未知时，在支持的情况下按操作身份查回，不自动重复操作。备份可能包含业务状态和受保护配置，应视为私有材料；没有核验支持的恢复行为前，不假定凭据可以跨机器或用户直接使用。

源码：[维护控制器](../../apps/desktop/src/main/maintenance-controller.ts)、[备份实现](../../packages/storage/src/backup.ts)、[设置界面](../../apps/desktop/src/renderer/settings-page.tsx)。

## 发布核验

记录实际覆盖：类型与相关工程测试、随包资源和原生依赖存在性、干净 Windows 安装与启动、模型配置与真实问数、同一数据根重启、受控退出、备份恢复及结果未知时查回、卸载后的数据保留。

真实供应商和模型行为、签名以及干净机器就绪需要独立证据，不能以开发启动成功代替。参见[开发检查](../development/contributing.zh-CN.md)、[评测](../evaluation/overview.zh-CN.md)、[产品限制](../product/overview.zh-CN.md)。
