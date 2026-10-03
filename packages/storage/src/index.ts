import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { canonicalJson, sha256Text } from "@agent-foundry/domain";

export type ObjectStorageConfig = {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export function storageConfigFromEnvironment(): ObjectStorageConfig {
  const bucket=process.env.OBJECT_STORAGE_BUCKET;
  const accessKeyId=process.env.OBJECT_STORAGE_ACCESS_KEY;
  const secretAccessKey=process.env.OBJECT_STORAGE_SECRET_KEY;
  if(!bucket||!accessKeyId||!secretAccessKey) {
    throw new Error("OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_ACCESS_KEY and OBJECT_STORAGE_SECRET_KEY are required");
  }
  return {
    endpoint:process.env.OBJECT_STORAGE_ENDPOINT||undefined,
    region:process.env.OBJECT_STORAGE_REGION||"us-east-1",
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle:(process.env.OBJECT_STORAGE_FORCE_PATH_STYLE??"true")==="true",
  };
}

export class ArtifactStore {
  readonly client:S3Client;
  constructor(readonly config:ObjectStorageConfig) {
    this.client=new S3Client({
      endpoint:config.endpoint,
      region:config.region,
      forcePathStyle:config.forcePathStyle,
      credentials:{accessKeyId:config.accessKeyId,secretAccessKey:config.secretAccessKey},
    });
  }

  async ensureBucket() {
    try {
      await this.client.send(new HeadBucketCommand({Bucket:this.config.bucket}));
    } catch {
      await this.client.send(new CreateBucketCommand({Bucket:this.config.bucket}));
    }
  }

  async putText(key:string,text:string,mediaType="application/json",expectedSha256?:string) {
    const sha256=sha256Text(text);
    if(expectedSha256&&expectedSha256!==sha256) {
      throw new Error(`artifact digest mismatch before upload expected=${expectedSha256} actual=${sha256}`);
    }
    await this.client.send(new PutObjectCommand({
      Bucket:this.config.bucket,
      Key:key,
      Body:text,
      ContentType:mediaType,
      Metadata:{sha256},
    }));
    return {sha256,byteSize:Buffer.byteLength(text)};
  }

  async putJson(key:string,value:unknown,expectedSha256?:string) {
    const body=canonicalJson(value);
    const sha256=sha256Text(body);
    if(expectedSha256&&expectedSha256!==sha256) {
      throw new Error(`artifact digest mismatch before upload expected=${expectedSha256} actual=${sha256}`);
    }
    return this.putText(key,body,"application/json",expectedSha256);
  }

  async head(key:string) {
    const result=await this.client.send(new HeadObjectCommand({
      Bucket:this.config.bucket,
      Key:key,
    }));
    return {
      byteSize:Number(result.ContentLength??0),
      sha256:result.Metadata?.sha256??null,
      etag:result.ETag??null,
    };
  }

  async verify(key:string,expectedSha256:string) {
    const head=await this.head(key);
    if(head.sha256!==expectedSha256) {
      throw new Error(`stored artifact metadata digest mismatch expected=${expectedSha256} actual=${head.sha256}`);
    }
    return head;
  }

  async getText(key:string):Promise<string> {
    const result=await this.client.send(new GetObjectCommand({
      Bucket:this.config.bucket,
      Key:key,
    }));
    if(!result.Body) throw new Error("object storage returned empty body");
    return result.Body.transformToString();
  }

  async getJson<T=unknown>(key:string):Promise<T> {
    return JSON.parse(await this.getText(key)) as T;
  }

  async listKeys(prefix=""):Promise<string[]> {
    const keys:string[]=[];
    let token:string|undefined;
    do {
      const result=await this.client.send(new ListObjectsV2Command({
        Bucket:this.config.bucket,
        Prefix:prefix||undefined,
        ContinuationToken:token,
      }));
      for(const item of result.Contents??[]) if(item.Key) keys.push(item.Key);
      token=result.IsTruncated?result.NextContinuationToken:undefined;
    } while(token);
    return keys;
  }
}
