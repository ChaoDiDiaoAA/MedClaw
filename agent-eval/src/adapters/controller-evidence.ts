import { TextDecoder } from 'node:util';
import { ControllerEvidenceInputSchema,ControllerEvidenceOutputSchema,type ControllerEvidenceInput } from '../../../packages/contracts/src/controller-evidence.ts';
import { equal } from '../scoring/rules.ts';
import { hashBytes } from './product-checksums.ts';
import { unwrap,type ProductAdapter } from './product.ts';

export async function readControllerOriginal(product:Pick<ProductAdapter,'instanceId'|'request'>,selector:ControllerEvidenceInput['selector'],ownerInstanceId=product.instanceId) {
  const parts:Buffer[]=[];let offset=0,hash:string|undefined,total:number|undefined;
  for(;;) {
    const input=ControllerEvidenceInputSchema.parse({expectedInstanceId:product.instanceId,ownerInstanceId,selector,offset,limit:65536});
    const page=ControllerEvidenceOutputSchema.parse(unwrap(await product.request('controller.evidence.read',input)));
    if(page.instanceId!==product.instanceId||page.ownerInstanceId!==ownerInstanceId||!equal(page.selector,selector)||page.offset!==offset||hash!==undefined&&page.sha256!==hash||total!==undefined&&page.bytes!==total)throw new Error('controller_evidence_identity_or_revision_conflict');
    hash=page.sha256;total=page.bytes;
    const bytes=Buffer.from(page.data,'base64');
    if(bytes.toString('base64')!==page.data||bytes.length!==Math.min(input.limit,total-offset)||page.nextOffset!==(offset+bytes.length<total?offset+bytes.length:null))throw new Error('controller_evidence_truncated');
    parts.push(bytes);if(page.nextOffset===null)break;offset=page.nextOffset;
  }
  const bytes=Buffer.concat(parts);if(bytes.length!==total||hashBytes(bytes)!==hash)throw new Error('controller_evidence_hash_mismatch');
  return {selector,ownerInstanceId,protocolValidated:true,bytes:total,original:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};
}
