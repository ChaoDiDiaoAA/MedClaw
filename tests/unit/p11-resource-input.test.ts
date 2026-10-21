import {expect,test} from 'bun:test';
import {resourceCommand} from '../../packages/contracts/src/resources';

test('p11 resource syntax recognizes only native leading commands and registered templates',()=>{
  expect(resourceCommand('/skill:device-detail-review check',['query'])).toEqual({kind:'skill',id:'device-detail-review'});
  expect(resourceCommand('/query\tmanufacturer',['query'])).toEqual({kind:'prompt',id:'query'});
  expect(resourceCommand('/unknown text',['query'])).toBeNull();
  expect(resourceCommand(' /query text',['query'])).toBeNull();
  expect(resourceCommand('explain /skill:query',['query'])).toBeNull();
});
