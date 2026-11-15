import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../content.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('  async function readTimeline()'),source.indexOf('\n  // ========================================================================\n  // Panel'));
async function scan(stall=false,delayed=false,atEnd=false){
 let now=1000000000, scrolls=0, result;
 const since=now-3*86400000;
 const pages=Array.from({length:7},(_,i)=>({items:[{id:String(i),ts:i===6?since-1:now-i*43200000}]}));
 const RAW=[JSON.stringify(pages.shift())];
 const context=vm.createContext({RAW,Map,JSON,Date:{now:()=>now},sleep:async ms=>{now+=ms},loginWall:()=>false,send:async msg=>msg.type==='scanHello'?{scan:true,since,deep:true}:result=msg,X:{fromGraphQL:j=>j.items,hasTimeline:()=>true},mergeItem:(map,it)=>map.set(it.id,it),window:{scrollY:0,innerHeight:100,scrollTo:()=>{scrolls++;if(!stall&&(!delayed||scrolls>2)&&pages.length)RAW.push(JSON.stringify(pages.shift()));}},document:{documentElement:{scrollHeight:100},body:{innerText:''},querySelector:s=>atEnd&&s==='article'?{}:null,querySelectorAll:()=>[]},TWEET:'article'});
 await vm.runInContext(fn+';readTimeline()',context);
 return {scrolls,result};
}
const full=await scan();assert.equal(full.scrolls,6,'must paginate past three scrolls and the 48-hour cutoff');assert.equal(full.result.error,'');assert.equal(full.result.tweets.length,7);
const delayed=await scan(false,true);assert.equal(delayed.result.error,'');assert.equal(delayed.result.tweets.length,7,'keep scrolling after data arrives before the DOM renders');
const ended=await scan(true,false,true);assert.equal(ended.result.error,'','rendered end without loader or retry is a completed timeline');
const stalled=await scan(true);assert.equal(stalled.result.error,'incomplete','stalled pagination cannot advance successful check');assert.equal(stalled.result.tweets.length,1,'keep partial results');
console.log('PASS pagination reaches previous check within three days; stalled page reports incomplete with partial results');
