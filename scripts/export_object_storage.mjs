import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore, storageConfigFromEnvironment } from "../packages/storage/dist/index.js";

const dest=process.argv[2];
if(!dest) throw new Error("destination path required");
const store=new ArtifactStore(storageConfigFromEnvironment());
await mkdir(dest,{recursive:true});
const keys=await store.listKeys();
for(const key of keys){
  const target=path.join(dest,...key.split("/"));
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(target,await store.getText(key));
}
console.log(JSON.stringify({status:"PASS",objects:keys.length,destination:dest}));
