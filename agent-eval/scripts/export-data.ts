import { loadDataset,snapshotCompiled } from '../src/datasets.ts';
if(import.meta.main) {
  const dataset=await loadDataset(Bun.argv[2]??'medclaw-agent-v1');
  console.log(JSON.stringify(Bun.argv.includes('--compiled')?{dataset:dataset.snapshot,compiled:snapshotCompiled(dataset)}:dataset.snapshot));
}
