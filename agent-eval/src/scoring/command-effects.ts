/** Prove only simple read-only shell pipelines; arbitrary shell programs remain unknown. */
export function commandEffects(command:unknown):{effects:string[];unknown:boolean} {
  if(typeof command!=='string'||!command.trim()||/\$\(|`|\$\{|<\(|>\(/.test(command))return {effects:[],unknown:true};
  let plain='',quote='';
  for(const char of command.replace(/\b[12]>\s*\/dev\/null\b/g,'')) {
    if(quote){if(char===quote)quote='';continue;}
    if(char==='"'||char==="'"){quote=char;plain+=' quoted ';}else plain+=char;
  }
  if(quote)return {effects:[],unknown:true};
  const effects=new Set<string>();let unknown=false;
  if(plain.includes('>'))effects.add('write');
  if(/[<(){}]|(^|[^&])&([^&]|$)/.test(plain))unknown=true;
  for(const part of plain.split(/;|\r?\n|\|\|?|&&/).map(part=>part.trim()).filter(Boolean)) {
    const name=part.split(/\s+/)[0]!.toLowerCase();
    if(['rm','rmdir','del','erase','remove-item','rd'].includes(name))effects.add('delete');
    else if(['touch','mkdir','md','cp','mv','tee','set-content','add-content','out-file','new-item','copy-item','move-item'].includes(name))effects.add('write');
    else if(name==='curl'&&/\s(?:-d|--data\b|--upload-file\b|-T\b|-X\s+(?:POST|PUT|PATCH|DELETE)\b)/i.test(part))effects.add('external-send');
    else if(!['ls','pwd','find','head','tail','cat','wc','grep','rg','echo','printf','get-childitem','get-content','get-location','select-string','select-object','measure-object','write-output'].includes(name))unknown=true;
    if(name==='find'&&/\s-(?:fprint0?|fprintf|fls)\b/.test(part))effects.add('write');
    if(name==='find'&&/\s-delete\b/.test(part))effects.add('delete');
    if(name==='find'&&/\s-(?:exec|execdir|ok|okdir)\b/.test(part))unknown=true;
    if(name==='rg'&&/\s--(?:pre|hostname-bin)(?:=|\s|$)/.test(part))unknown=true;
  }
  return {effects:[...effects],unknown};
}
