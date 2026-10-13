import {test,expect} from 'bun:test';
import {loadDataset,datasetCoverage,auditLineage} from '../../src/datasets.ts';
test('category and purpose are explicit, and Smoke is a valid selection rather than copied cases',async()=>{
  const dataset=await loadDataset(),coverage=datasetCoverage(dataset);
  expect(Object.values(coverage.categories).every(count=>count>0)).toBe(true);
  expect(Object.values(coverage.categories).reduce((a,b)=>a+b,0)).toBe(50);
  expect(coverage.evalTypes.capability).toBeGreaterThan(0);expect(coverage.evalTypes.regression).toBeGreaterThan(0);
  expect(dataset.manifest.smoke.every(id=>dataset.manifest.members.includes(id))).toBe(true);
  expect(auditLineage(dataset)).toMatchObject({developerVisibleCases:50,blindHoldoutCases:0});
  for(const item of dataset.snapshot.cases){expect(item.input).not.toHaveProperty('materials');expect(item.expected).not.toHaveProperty('checks');}
});
