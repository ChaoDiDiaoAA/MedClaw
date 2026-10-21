# Windows 打包与维护

[English](windows-packaging.md) · [文档目录](../README.md)

## 构建入口与前置

当前打包目标为 Windows x64。[构建配置](../../apps/desktop/electron-builder.config.ts)使用 Electron `44.5.1` 与按用户安装的 NSIS 安装包，允许选择安装目录、不请求提权、不在安装后自动启动，并在卸载时保留应用数据。当前配置关闭可执行文件签名，不能把结果称为已签名构建。

项目声明的 `@tintinweb/pi-subagents@0.19.0` 补丁目前缺少已跟踪文件。宣称干净依赖安装或完整可复现构建前须处理这一既有前置；现成开发环境和工程夹具不能代替干净机器验收。

依赖与构建前置可用后执行：

```powershell
bun run build:desktop
bun run package:desktop
```

[构建脚本](../../apps/desktop/build.ts)准备桌面代码、生产运行资源与随包工具。Electron-builder 读取 `.build/package-app` 和 `.build/package-resources/medclaw`，安装包输出到 `.build/installers`。运行资源准备可能需要网络，构建文件和安装包不是业务数据备份。

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
