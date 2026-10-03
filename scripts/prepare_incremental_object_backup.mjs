import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore, storageConfigFromEnvironment, assertSafeObjectKey } from "../packages/storage/dist/index.js";
import { sha256Text } from "../packages/domain/dist/index.js";

const stage=process.env.INCREMENTAL_BACKUP_STAGE;
const stateFile=process.env.INCREMENTAL_BACKUP_STATE;
const generation=process.env.INCREMENTAL_BACKUP_GENERATION;
if(!stage||!stateFile||!generation) throw new Error("INCREMENTAL_BACKUP_STAGE, INCREMENTAL_BACKUP_STATE and INCREMENTAL_BACKUP_GENERATION are required");
const store=new ArtifactStore(storageConfigFromEnvironment());
const previous=await readFile(stateFile,"utf8").then(JSON.parse).catch(error=>{
  if(error.code==="ENOENT") return {formatVersion:1,objects:{}};
  throw error;
});
if(previous.formatVersion!==1||typeof previous.objects!=="object") throw new Error("incremental backup state format is unsupported");
await mkdir(path.join(stage,"payloads"),{recursive:true});
const current={};
const changed=[];
for(const key of await store.listKeys()){
  assertSafeObjectKey(key);
  const head=await store.head(key);
  if(!head.sha256) throw new Error(`object ${key} has no verifiable sha256 metadata`);
  const item={sha256:head.sha256,byteSize:head.byteSize,mediaType:head.mediaType};
  current[key]=item;
  const old=previous.objects[key];
  if(!old||old.sha256!==item.sha256||old.byteSize!==item.byteSize||old.mediaType!==item.mediaType){
    const body=await store.getText(key);
    if(sha256Text(body)!==item.sha256) throw new Error(`object ${key} digest changed during backup`);
    await writeFile(path.join(stage,"payloads",`${item.sha256}.payload`),body);
    changed.push({key,...item});
  }
}
const removed=Object.keys(previous.objects).filter(key=>!(key in current)).sort();
const manifest={formatVersion:1,generation,createdAt:new Date().toISOString(),objects:current};
await writeFile(path.join(stage,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
await writeFile(path.join(stage,"changes.json"),JSON.stringify({formatVersion:1,generation,changed,removed},null,2)+"\n");
console.log(JSON.stringify({status:"PASS",generation,objects:Object.keys(current).length,changed:changed.length,removed:removed.length}));
