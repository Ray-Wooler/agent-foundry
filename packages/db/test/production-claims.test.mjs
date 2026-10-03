import test from "node:test";
import assert from "node:assert/strict";

const databaseUrl=process.env.DATABASE_URL;

test("operational reclaim is fenced by a fresh lock token",{skip:!databaseUrl},async()=>{
  const {Client}=await import("pg");
  const client=new Client({connectionString:databaseUrl});
  await client.connect();
  try {
    const inserted=await client.query(`
      INSERT INTO operational_jobs(job_type,payload,status,attempts,max_attempts,locked_at,locked_by,lock_token)
      VALUES ('BACKUP_VERIFY','{}'::jsonb,'RUNNING',1,3,now()-interval '10 minutes','old-worker',gen_random_uuid())
      RETURNING id,lock_token`);
    const id=inserted.rows[0].id;
    const oldToken=inserted.rows[0].lock_token;
    const claim=await client.query(`
      WITH next AS (
        SELECT id FROM operational_jobs
        WHERE (status IN ('QUEUED','RETRY') AND available_at<=now())
           OR (status='RUNNING' AND locked_at < now()-($2::text||' seconds')::interval)
        FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE operational_jobs j
      SET status='RUNNING',locked_at=now(),locked_by=$1,lock_token=gen_random_uuid(),attempts=j.attempts+1
      FROM next WHERE j.id=next.id
      RETURNING j.lock_token`,["new-worker","300"]);
    assert.equal(claim.rowCount,1);
    const newToken=claim.rows[0].lock_token;
    assert.notEqual(newToken,oldToken);
    const staleFinish=await client.query(
      "UPDATE operational_jobs SET status='COMPLETED' WHERE id=$1 AND locked_by=$2 AND lock_token=$3",
      [id,"old-worker",oldToken],
    );
    assert.equal(staleFinish.rowCount,0);
    const currentFinish=await client.query(
      "UPDATE operational_jobs SET status='COMPLETED',locked_at=NULL,locked_by=NULL,lock_token=NULL WHERE id=$1 AND locked_by=$2 AND lock_token=$3",
      [id,"new-worker",newToken],
    );
    assert.equal(currentFinish.rowCount,1);
    await client.query("DELETE FROM operational_jobs WHERE id=$1",[id]);
  } finally { await client.end(); }
});

test("registration effect claim rejects simultaneous different keys",{skip:!databaseUrl},async()=>{
  const {Client}=await import("pg");
  const a=new Client({connectionString:databaseUrl});
  const b=new Client({connectionString:databaseUrl});
  await Promise.all([a.connect(),b.connect()]);
  try {
    let pub=await a.query("SELECT id FROM publication_records ORDER BY published_at LIMIT 1");
    if(!pub.rowCount) {
      const packageRow=await a.query("SELECT id FROM release_package_records ORDER BY created_at LIMIT 1");
      const user=await a.query("SELECT id FROM app_users ORDER BY created_at LIMIT 1");
      pub=await a.query(
        `INSERT INTO publication_records(
           release_package_record_id,channel,published_by_user_id,idempotency_key,publication_payload,status
         ) VALUES ($1,'claim-test',$2,'claim-publication-key','{}'::jsonb,'PUBLISHED') RETURNING id`,
        [packageRow.rows[0].id,user.rows[0].id],
      );
    }
    const publicationId=pub.rows[0].id;
    await a.query("DELETE FROM frankai_registration_attempts WHERE publication_record_id=$1",[publicationId]);
    const results=await Promise.allSettled([
      a.query("INSERT INTO frankai_registration_attempts(publication_record_id,idempotency_key,request_payload) VALUES ($1,$2,'{}'::jsonb)",[publicationId,"concurrent-key-a"]),
      b.query("INSERT INTO frankai_registration_attempts(publication_record_id,idempotency_key,request_payload) VALUES ($1,$2,'{}'::jsonb)",[publicationId,"concurrent-key-b"]),
    ]);
    assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
    assert.equal(results.filter(x=>x.status==="rejected" && x.reason?.code==="23505").length,1);
    await a.query("DELETE FROM frankai_registration_attempts WHERE publication_record_id=$1",[publicationId]);
  } finally { await Promise.all([a.end(),b.end()]); }
});
