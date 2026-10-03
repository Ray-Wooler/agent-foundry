import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ArtifactStore, storageConfigFromEnvironment } from "../packages/storage/dist/index.js";

const source=process.argv[2];
if(!source) throw new Error("source path required");
const store=new ArtifactStore(storageConfigFromEnvironment());
await store.ensureBucket();

async function walk(dir,base=dir){
  const out=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) out.push(...await walk(full,base));
    else out.push({full,key:path.relative(base,full).split(path.sep).join("/")});
  }
  return out;
}

const files=await walk(source);
for(const file of files){
  await store.putText(file.key,await readFile(file.full,"utf8"));
}
console.log(JSON.stringify({status:"PASS",objects:files.length,source}));
