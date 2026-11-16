import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../content.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('  async function readTimeline()'),source.indexOf('\n  // ========================================================================\n  // Panel'));
async function scan(stall=false,delayed=false,atEnd=false,cursor=false,empty=false,zeroFirst=false,nativeEmpty=false,noResponse=false,rateLimited=false){
 let now=1000000000, scrolls=0, result;
 const since=now-3*86400000;
 const pages=Array.from({length:7},(_,i)=>({items:[{id:String(i),ts:i===6?since-1:now-i*43200000}]}));
 if(zeroFirst)pages[0].items=[];
 if(empty)pages.splice(0,pages.length,{items:[]});
 if(cursor)for(const p of pages)p.entries=[{content:{cursorType:'Bottom',value:'next'}}];
 const RAW=noResponse?[]:[JSON.stringify(pages.shift())];
 const context=vm.createContext({RAW,HTTP_ERROR:rateLimited?{error:"rateLimit",retryAt:now+120000}:null,Map,JSON,Date:{now:()=>now},sleep:async ms=>{now+=ms},loginWall:()=>false,send:async msg=>msg.type==='scanHello'?{scan:true,since,deep:true}:result=msg,X:{fromGraphQL:j=>j.items,hasTimeline:()=>true},mergeItem:(map,it)=>map.set(it.id,it),window:{scrollY:0,innerHeight:100,scrollTo:()=>{scrolls++;if(!stall&&(!delayed||scrolls>2)&&pages.length)RAW.push(JSON.stringify(pages.shift()));}},document:{documentElement:{scrollHeight:100},body:{innerText:''},querySelector:s=>nativeEmpty&&s==='[data-testid="emptyState"]'?{textContent:'No results for this query'}:atEnd&&s==='article'?{}:null,querySelectorAll:()=>[]},TWEET:'article'});
 await vm.runInContext(fn+';readTimeline()',context);
 return {scrolls,result};
}
const full=await scan();assert.equal(full.scrolls,6,'must paginate past three scrolls and the 48-hour cutoff');assert.equal(full.result.error,'');assert.equal(full.result.tweets.length,7);
const delayed=await scan(false,true);assert.equal(delayed.result.error,'');assert.equal(delayed.result.tweets.length,7,'keep scrolling after data arrives before the DOM renders');
const ended=await scan(true,false,true);assert.equal(ended.result.error,'incomplete','DOM bottom alone does not prove all pages loaded');
const stalled=await scan(true);assert.equal(stalled.result.error,'incomplete','stalled pagination cannot advance successful check');assert.equal(stalled.result.tweets.length,1,'keep partial results');
console.log('PASS pagination reaches previous check within three days; stalled page reports incomplete with partial results');

const shortPage=await scan(false,false,false,true);assert.equal(shortPage.result.tweets.length,7,'a short parsed page with a bottom cursor must continue until the boundary');
console.log('PASS short pages with continuation cursors are not treated as exhausted');

const emptyPage=await scan(false,false,false,true,true);assert.equal(emptyPage.result.error,'incomplete','empty parsed data with a continuation cursor is not proof of completion');
const zero=await scan(false,false,false,true,false,true);assert.equal(zero.result.tweets.length,6,'zero parsed first page must still load later pages');
const nativeEmpty=await scan(false,false,false,true,true,false,true);assert.equal(nativeEmpty.result.error,'','explicit native empty result is valid');

const domEmpty=await scan(true,false,false,false,true,false,true,true);assert.equal(domEmpty.result.error,'','native explicit empty result is valid even when its network response was missed');

const limited=await scan(true,false,false,false,false,false,false,true,true);assert.equal(limited.result.error,"rateLimit");assert.equal(limited.scrolls,0,"HTTP 429 must stop pagination immediately");assert.ok(limited.result.retryAt);
