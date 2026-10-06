import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { Script, createContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

test('the served page contains executable browser JavaScript', async (t) => {
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, WEB_PORT: String(port), API_PUBLIC_URL: 'https://foundry.frankai.online/api' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  let errors = '';
  child.stderr.on('data', (chunk) => { errors += chunk; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('web server did not start: ' + errors)), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('agent-foundry-web listening')) { clearTimeout(timer); resolve(); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('web server exited: ' + code + ' ' + errors)); });
  });
  const response = await fetch('http://127.0.0.1:' + port + '/');
  assert.equal(response.status, 200);
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'the page must include its client script');
  const elements = new Map();
  const element = () => ({ textContent:'', value:'', disabled:false, children:[], classList:{add(){},remove(){},toggle(){}}, append(...items){this.children.push(...items);}, appendChild(item){this.children.push(item);}, replaceChildren(){this.children=[];}, scrollIntoView(){} });
  const first='11111111-1111-1111-1111-111111111111';
  const second='22222222-2222-2222-2222-222222222222';
  let hash='';
  const context=createContext({
    document:{getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},createElement:element,createTextNode:text=>({textContent:text})},
    sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}},
    location:{get hash(){return hash;}},history:{replaceState(a,b,url){hash=url;}},
    window:{addEventListener(){}}, URLSearchParams, crypto:globalThis.crypto, setTimeout,
    fetch:async url=>({ok:true,json:async()=>url.includes('?offset=')?{submissions:[{id:first,requested_name:'Saved agent',status:'REQUIRES_REVIEW'}],nextOffset:null}:{id:url.split('/').at(-1),status:'REQUIRES_REVIEW',candidate:{version:url.endsWith(first)?'0.1.0':'0.1.1'},semanticReview:url.endsWith(first)?{decision:'REQUEST_CHANGES'}:null,revisionLineage:[],stages:[]}}),
  });
  new Script(scripts[0][1]).runInContext(context);
  await new Script('openSubmission("'+first+'")').runInContext(context);
  assert.equal(elements.get('reviewButton').disabled,true);
  await new Script('openSubmission("'+second+'")').runInContext(context);
  assert.equal(hash,'#submission='+second);
  assert.match(elements.get('candidate').textContent,/0.1.1/);
  assert.equal(elements.get('reviewButton').disabled,false);
  assert.equal(elements.get('submissionsList').children.length,1);
  assert.equal(elements.get('evaluationState').textContent,'No evaluation plan.');
  let releases;
  let evalFetches=0;
  context.fetch=async url=>({ok:true,json:async()=>{
    if(url.includes('?offset='))return new Promise(resolve=>{releases=()=>resolve({submissions:[],nextOffset:null});});
    if(url.includes('/evaluation-plans/')){evalFetches++;return {};}
    return {status:'REQUIRES_REVIEW',candidate:{},stages:[],revisionLineage:[],evaluationPlanId:'old-plan'};
  }});
  const pending=new Script('openSubmission("'+first+'")').runInContext(context);
  while(!releases)await new Promise(resolve=>setImmediate(resolve));
  new Script('selectionGeneration++;currentTransformationId="'+second+'"').runInContext(context);
  releases();await pending;
  assert.equal(evalFetches,0,'superseded selection must not start evaluation polling');
  let cleared=false;
  context.sessionStorage.removeItem=()=>{cleared=true;};
  context.fetch=async url=>({ok:!url.includes('/transformations/'),json:async()=>url.endsWith('/v1/me')?{user:{email:'owner@example.com'},workspaces:[]}:url.includes('?offset=')?{submissions:[],nextOffset:null}:{error:'not_found'}});
  context.testSession="test-fixture-session";
  new Script("token=testSession").runInContext(context);
  await new Script('restore()').runInContext(context);
  assert.equal(cleared,false,'failed selection restore preserves authentication');

  for (const [index, match] of scripts.entries()) {
    assert.doesNotThrow(() => new Script(match[1], { filename: 'served-client-' + index + '.js' }));
  }
});
