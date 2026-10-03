import { ArtifactStore, storageConfigFromEnvironment } from "../packages/storage/dist/index.js";
const store=new ArtifactStore(storageConfigFromEnvironment());
await store.ensureBucket();
console.log(JSON.stringify({status:"PASS",bucket:store.config.bucket}));
