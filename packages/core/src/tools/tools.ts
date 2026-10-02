import type { AnyToolDefinition } from "@medclaw/contracts/tool";
import type { CatalogService } from "../data/catalog-service";
import type { QueryService } from "../data/query-service";
import type { EvidenceReader } from "../evidence/evidence-reader";
import { createReadDataScopeTool } from "./business-tools/read-data-scope";
import { createListBatchesTool } from "./business-tools/list-batches";
import { createReadBatchTool } from "./business-tools/read-batch";
import { createCheckDataCoverageTool } from "./business-tools/check-data-coverage";
import { createListFilterValuesTool } from "./business-tools/list-filter-values";
import { createResolveDeviceTool } from "./business-tools/resolve-device";
import { createReadDeviceTool } from "./business-tools/read-device";
import { createQueryCurrentDevicesTool } from "./business-tools/query-current-devices";
import { createQueryDeviceChangesTool } from "./business-tools/query-device-changes";
import { createReadQueryTool } from "./business-tools/read-query";
import { createReadQueryPageTool } from "./business-tools/read-query-page";
import { createListQueryEvidenceTool } from "./business-tools/list-query-evidence";
import { createReadQueryEvidenceTool } from "./business-tools/read-query-evidence";
import { createReadEvidenceRowsTool } from "./business-tools/read-evidence-rows";
import { createReadSourceMetadataTool } from "./business-tools/read-source-metadata";

export type BusinessToolDependencies = { catalog: CatalogService; queries: QueryService; evidence: EvidenceReader };

export function createBusinessTools(dependencies: BusinessToolDependencies): AnyToolDefinition[] {
  return [
    createReadDataScopeTool(dependencies),
    createListBatchesTool(dependencies),
    createReadBatchTool(dependencies),
    createCheckDataCoverageTool(dependencies),
    createListFilterValuesTool(dependencies),
    createResolveDeviceTool(dependencies),
    createReadDeviceTool(dependencies),
    createQueryCurrentDevicesTool(dependencies),
    createQueryDeviceChangesTool(dependencies),
    createReadQueryTool(dependencies),
    createReadQueryPageTool(dependencies),
    createListQueryEvidenceTool(dependencies),
    createReadQueryEvidenceTool(dependencies),
    createReadEvidenceRowsTool(dependencies),
    createReadSourceMetadataTool(dependencies),
  ];
}
