import { mkdir,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { datasetFixture } from '../report-fixture.ts';
import { loadDataset } from '../../src/datasets.ts';
export async function writeJson(root:string,path:string,value:unknown) {await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),JSON.stringify(value,null,2)+'\n');}
export async function createDatasetFixture(root:string) {await writeJson(root,'snapshot.json',datasetFixture());return (await loadDataset(root)).manifest;}
