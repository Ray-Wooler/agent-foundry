import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore, storageConfigFromEnvironment, assertSafeObjectKey } from "../packages/storage/dist/index.js";
import { sha256Text } from "../packages/domain/dist/index.js";

const manifestPath=process.argv[2];
const payloadDir=process.argv[3];
if(!manifestPath||!payloadDir) throw new Error("manifest and payload directory are required");
const manifest=JSON.parse(await readFile(manifestPath,"utf8"));
if(manifest.formatVersion!==1||typeof manifest.objects!=="object") throw new Error("unsupported incremental manifest");
const store=new ArtifactStore(storageConfigFromEnvironment());
await store.ensureBucket();
const existing=await store.listKeys();
if(existing.length&&!(/^true$/i.test(process.env.RESTORE_ALLOW_EXISTING??"false"))) throw new Error("restore target bucket is not empty");
await mkdir(payloadDir,{recursive:true});
let restored=0;
for(const [key,item] of Object.entries(manifest.objects)){
  assertSafeObjectKey(key);
  const body=await readFile(path.join(payloadDir,`${item.sha256}.payload`),"utf8");
  if(sha256Text(body)!==item.sha256) throw new Error(`restored object digest mismatch for ${key}`);
  await store.putText(key,body,item.mediaType,item.sha256);
  restored++;
}
console.log(JSON.stringify({status:"PASS",generation:manifest.generation,objects:restored}));
