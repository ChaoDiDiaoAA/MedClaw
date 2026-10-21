# 数据导入、查询与导出

[English](data-import.md) · [使用入门](getting-started.zh-CN.md) · [文档目录](../README.md)

## 数据包要求

业务数据不随仓库发布。当前导入器接收扁平 CSV/JSON 快照目录，不直接接收任意表格。Excel 等原件先离线整理，再制作满足[数据契约](../../packages/contracts/src/data.ts)和[导入检查](../../packages/core/src/data/import-service.ts)的数据包。

```text
snapshot-package/
├── manifest.json
├── zhejiang_YYYY-MM-DD.csv
├── zhejiang_YYYY-MM-DD.metadata.json
├── entity-lineage.csv
├── source-lock.json
├── adjustment-lineage.csv
├── validation-report.json
├── selection-report.json
└── 使用说明.md
```

可以包含多个业务日及对应元数据，`README.md` 可选。manifest 声明交付路径、字节数、业务文件数、业务字节数、行数和总量，交付文件清单不包含 manifest 自身。导入器检查精确允许的扁平文件集、绑定一致性、行身份、来源引用与日期；文件名正确不等于数据包合格。

业务 CSV 列为：

```text
device_id,device_name,source_submission_id,source_applicant,category,region,snapshot_date,price_cents,currency,unit,status,manufacturer,distributor,source_refs_json,field_origins_json
```

价格使用整数分和 `CNY`，缺失价格留空，不能变成零。元数据、实体映射、来源登记、业务行和字段来源必须一致。公开、模拟和推导字段分别保留来源标记，不能因名称相近就把源申请人推断为规范生产企业。

## 预览与确认

1. 通过 **Data Workspace → Choose snapshot directory** 选择目录。
2. 核查日期、地区、行数、实体数、重复批次和报告问题。
3. 对通过检查的预览使用 **Confirm import**，材料发生变化时由导入流程重新核验。
4. 选择后续工作获准使用的批次；导入不等于所有 Run 自动拥有全部批次权限。

## 查询口径

当前记录、变化事件、分组聚合和趋势使用不同统计对象与时间口径。检查实际日期、范围、分组、覆盖缺口、币种和单位。零、字段缺失、快照缺失分别保留；后续快照不能静默替代所问早期日期，记录数也不等于实体库存。

通过 **Query History** 查看已保存结果与依据。使用明确条件或[意图识别](../intent/overview.zh-CN.md)建立请求，条件缺失或有歧义时可能需要澄清。Query、Evidence 身份关联已保存来源行，参见[公开查询契约](../architecture/behavior-contracts.zh-CN.md#采购数据查询)。

## 导出与删除

使用已保存 Query 的显式导出操作。[导出服务](../../packages/core/src/data/export-service.ts)绑定原查询与回答依据，包含受支持的完整结果范围，而不是仅当前可见页。生成、登记和目标复制分别记录，生成文件不证明复制完成。自动 `EXPORT_RESULT` 意图执行目前禁用。

数据删除是独立的明确产品操作。核对所选目标与结果状态，未知结果不能被当成删除完成，也不能据此盲目重试。业务数据、凭据和原始执行记录不纳入源码提交，发送材料前检查实际内容。
