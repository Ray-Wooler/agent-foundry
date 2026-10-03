import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore, storageConfigFromEnvironment, assertSafeObjectKey } from "../packages/storage/dist/index.js";

const dest=process.argv[2];
if(!dest) throw new Error("destination path required");
const store=new ArtifactStore(storageConfigFromEnvironment());
await mkdir(dest,{recursive:true});
const keys=await store.listKeys();
for(const key of keys){
  assertSafeObjectKey(key);
  const base=path.resolve(dest);
  const target=path.resolve(base,...key.split("/"));
  if(target!==base && !target.startsWith(base+path.sep)) throw new Error("object key escapes export destination");
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,await store.getText(key));
}
console.log(JSON.stringify({status:"PASS",objects:keys.length,destination:dest}));
