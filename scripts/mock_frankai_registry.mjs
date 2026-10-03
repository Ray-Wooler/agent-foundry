import { createServer } from "node:http";

const port=Number(process.env.MOCK_FRANKAI_PORT??4010);
const registrations=new Map();
let requests=0;

const server=createServer(async(req,res)=>{
  if(req.method==="GET"&&req.url==="/_state"){
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify({requests,registrations:[...registrations.entries()]}));
    return;
  }
  if(req.method!=="POST"||req.url!=="/v1/agent-releases"){
    res.writeHead(404);res.end();return;
  }
  const key=req.headers["idempotency-key"];
  if(typeof key!=="string"||!key){
    res.writeHead(400,{"content-type":"application/json"});
    res.end(JSON.stringify({error:"idempotency_key_required"}));
    return;
  }
  let body="";
  for await(const chunk of req) body+=chunk;
  const payload=JSON.parse(body||"{}");
  requests+=1;

  const existing=registrations.get(key);
  if(existing){
    res.writeHead(200,{"content-type":"application/json"});
    res.end(JSON.stringify(existing));
    return;
  }

  const response={
    registration_reference:"frankai-reg-"+String(registrations.size+1).padStart(4,"0"),
    publication_record_id:payload.publicationRecordId,
    package_sha256:payload.release?.packageSha256,
  };
  registrations.set(key,response);
  res.writeHead(201,{"content-type":"application/json"});
  res.end(JSON.stringify(response));
});

server.listen(port,"127.0.0.1",()=>console.log(`mock FrankAI registry listening on :${port}`));
