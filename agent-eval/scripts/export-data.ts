import { loadDataset } from '../src/datasets.ts';
if(import.meta.main)console.log(JSON.stringify((await loadDataset()).snapshot));
