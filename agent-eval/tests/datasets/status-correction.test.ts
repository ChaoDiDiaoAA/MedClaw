import {test,expect} from 'bun:test';
import {parseAuthoredSource,independentExpectation} from '../../src/independent-gold.ts';
import {loadDataset} from '../../src/datasets.ts';
test('source status, zero price, null price and date absence are distinct facts',async()=>{
  const dataset=await loadDataset(),rows=parseAuthoredSource(dataset.snapshot.fixtures['procurement.csv']!);
  expect(independentExpectation(rows,{op:'current',region:'浙江',date:'2026-09-29',status:'suspended'}).sets).toEqual(['SYN-ZJ-B@synthetic-zj-v1','SYN-ZJ-C@synthetic-zj-v1']);
  expect(independentExpectation(rows,{op:'current',region:'浙江',date:'2026-09-28',device:'SYN-ZJ-B'}).numeric).toEqual([{id:'SYN-ZJ-B@synthetic-zj-v1',value:0,unit:'CNY cents'}]);
  expect(independentExpectation(rows,{op:'current',region:'浙江',date:'2026-10-02',device:'SYN-ZJ-C'}).interpretation.nullPriceDeviceIds).toEqual(['SYN-ZJ-C@synthetic-zj-v1']);
  expect(independentExpectation(rows,{op:'current',region:'浙江',date:'2026-09-30'}).interpretation.actualDataDate).toBeNull();
});
