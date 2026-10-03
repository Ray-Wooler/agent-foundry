import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore, storageConfigFromEnvironment } from "../packages/storage/dist/index.js";

const dest=process.argv[2];
if(!dest) throw new Error("destination path required");
const root=path.resolve(dest);
const store=new ArtifactStore(storageConfigFromEnvironment());
await mkdir(root,{recursive:true});
const keys=await store.listKeys();
for(const key of keys){
  const segments=key.split("/");
  if(!segments.length || segments.some(segment=>!segment || segment==="." || segment===".." || segment.includes("\\"))) {
    throw new Error(`unsafe object-storage key cannot be exported: ${key}`);
  }
  const target=path.resolve(root,...segments);
  if(target!==root && !target.startsWith(root+path.sep)) {
    throw new Error(`object-storage key escapes backup destination: ${key}`);
  }
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,await store.getText(key));
}
console.log(JSON.stringify({status:"PASS",objects:keys.length,destination:root}));
