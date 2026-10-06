import test from 'node:test';
import assert from 'node:assert/strict';
import {castSpell,magicAccess,magicPlan,magicResult,complicationIndex,magicChat,magicDialog,COMPLICATIONS} from '../module/magic.mjs';

function fixture({rank='2',level='2',will=5,free=false}={}) {
  const spell={id:'spell',type:'spell',name:'Flame',system:{rank,schoolId:'fire',noWillCost:free}};
  const talent={id:'talent',type:'talent',name:'Fire school',system:{level,linkId:'fire'}};
  const items=[spell,talent];items.get=id=>items.find(item=>item.id===id);
  const writes=[],messages=[],calls=[];
  const actor={isOwner:true,name:'Mage',items,system:{sheet:{trackers:{willpower:will},notes:{text:'keep'}}},
    async update(data){writes.push(data);this.system.sheet.trackers.willpower=data['system.sheet.trackers.willpower'];return this;}};
  const options={choose:async()=>({will:2}),roll:async count=>{calls.push(count);return {values:Array(count).fill(2)};},post:async(...args)=>messages.push(args)};
  return {actor,spell,talent,options,writes,messages,calls};
}

test('school links are nonempty, case sensitive, trim edges and use the highest valid duplicate level',()=>{
  const {actor,spell,talent}=fixture();
  spell.system.schoolId=' fire ';talent.system.linkId=' fire ';
  actor.items.push({type:'talent',name:'Higher',system:{level:'4',linkId:'fire'}},{type:'talent',system:{level:'8x',linkId:'fire'}});
  assert.equal(magicAccess(actor,spell).schoolRank,4);
  assert.equal(magicAccess(actor,spell).talentName,'Higher');
  spell.system.schoolId='Fire';assert.throws(()=>magicAccess(actor,spell),/нужен талант/);
  spell.system.schoolId='';talent.system.linkId='';assert.throws(()=>magicAccess(actor,spell),/не указан/);
});

test('spell and school ranks must be positive integers; one rank above guarantees a complication',()=>{
  for(const value of ['',0,-1,'2x','1.5','Infinity','1e2']) {
    const f=fixture({rank:value});assert.throws(()=>magicAccess(f.actor,f.spell),/Ранг/);
    const g=fixture({level:value});assert.throws(()=>magicAccess(g.actor,g.spell),/нужен талант/);
  }
  for(const [rank,chance] of [[1,false],[2,false],[3,true]]) {
    const f=fixture({rank:String(rank)});assert.equal(magicAccess(f.actor,f.spell).chance,chance);
  }
  const f=fixture({rank:'4'});assert.throws(()=>magicAccess(f.actor,f.spell),/более чем на один/);
});

test('paid magic has minimum one WP regardless of rank and never accepts excess or fractional cost',()=>{
  const f=fixture({rank:'3',level:'3'}),access=magicAccess(f.actor,f.spell);
  const plan=magicPlan(access,{will:1},1);
  assert.equal(plan.cost,1);assert.equal(plan.basePower,1);assert.equal(plan.dice,1);
  for(const value of [0,-1,'',1.5,'2x'])assert.throws(()=>magicPlan(access,{will:value},5),/минимум 1/);
  assert.throws(()=>magicPlan(access,{will:6},5),/Недостаточно/);
});

test('free magic uses spell rank; safe casting reduces dice but never power or cost',()=>{
  const f=fixture({rank:'2',level:'4',free:true,will:0}),access=magicAccess(f.actor,f.spell);
  const free=magicPlan(access,{will:99},0);
  assert.equal(free.cost,0);assert.equal(free.basePower,2);assert.equal(free.dice,2);
  const safe=magicPlan(access,{safe:true},0);
  assert.equal(safe.cost,0);assert.equal(safe.basePower,2);assert.equal(safe.dice,0);
  assert.equal(magicResult(safe,[]).power,2);
  access.free=false;
  const paid=magicPlan(access,{will:4,safe:true},4);
  assert.equal(paid.cost,4);assert.equal(paid.basePower,4);assert.equal(paid.dice,2);
});

test('sixes enhance power, zero sixes still cast, and ones/chance casting share one complication',()=>{
  const f=fixture(),plan=magicPlan(magicAccess(f.actor,f.spell),{will:3},5);
  assert.equal(magicResult(plan,[6,6,2]).power,5);
  assert.equal(magicResult(plan,[2,3,4]).power,3);
  assert.equal(magicResult(plan,[1,1,6]).complicationRequired,true);
  assert.equal(magicResult({...plan,chance:true},[2,3,4]).complicationRequired,true);
  assert.throws(()=>magicResult(plan,[6]),/Некорректный/);
});

test('D66 maps all 36 ordered outcomes to twelve equal-probability entries',()=>{
  const counts=Array(12).fill(0);
  for(let tens=1;tens<=6;tens++)for(let units=1;units<=6;units++)counts[complicationIndex(tens,units)-1]++;
  assert.deepEqual(counts,Array(12).fill(3));assert.equal(COMPLICATIONS.length,12);
  assert.equal(complicationIndex(1,3),1);assert.equal(complicationIndex(1,4),2);assert.equal(complicationIndex(6,6),12);
  assert.throws(()=>complicationIndex(0,2));
});

test('cancel never spends, rolls or sends a message; permission and missing talent deny before the dialog',async()=>{
  const f=fixture();f.options.choose=async()=>null;
  assert.equal(await castSpell(f.actor,'spell',f.options),null);
  assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);assert.equal(f.messages.length,0);
  f.options.choose=async()=>{throw Error('must not open');};
  f.actor.isOwner=false;await assert.rejects(castSpell(f.actor,'spell',f.options),/владелец/);
  f.actor.isOwner=true;await assert.rejects(castSpell(f.actor,'spell',{...f.options,canEdit:()=>false}),/владелец/);
  f.talent.system.linkId='other';await assert.rejects(castSpell(f.actor,'spell',f.options),/нужен талант/);
  assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);
});

test('paying and free casting only affect will, and safe zero-dice casts never evaluate a Roll',async()=>{
  const f=fixture();f.options.choose=async()=>({will:1});
  const result=await castSpell(f.actor,'spell',f.options);
  assert.equal(result.result.basePower,1);assert.deepEqual(f.calls,[1]);
  assert.deepEqual(f.writes,[{'system.sheet.trackers.willpower':4}]);assert.equal(f.actor.system.sheet.notes.text,'keep');
  const g=fixture({free:true,will:0,level:'4'});g.options.choose=async()=>({safe:true});
  assert.equal((await castSpell(g.actor,'spell',g.options)).result.power,2);
  assert.equal(g.writes.length,0);assert.equal(g.calls.length,0);assert.equal(g.messages.length,1);
  g.talent.system.linkId='no';await assert.rejects(castSpell(g.actor,'spell',g.options),/нужен талант/);
});

test('chance casting plus multiple ones rolls D66 only once and never applies its effects',async()=>{
  const f=fixture({rank:'3'});f.options.roll=async count=>{f.calls.push(count);return {values:f.calls.length===1?[1,1]:[6,6]};};
  const result=await castSpell(f.actor,'spell',f.options);
  assert.deepEqual(f.calls,[2,2]);assert.deepEqual(result.complication,{d66:66,index:12});
  assert.equal(f.messages.length,1);assert.equal(f.writes.length,1);
});

test('same-client duplicate calls share an Actor lock across dialogs and release it after cancel',async()=>{
  const f=fixture();let resolveChoice,opened=0;
  f.options.choose=()=>{opened++;return new Promise(resolve=>{resolveChoice=resolve;});};
  const first=castSpell(f.actor,'spell',f.options);
  while(!resolveChoice)await Promise.resolve();
  assert.equal(await castSpell(f.actor,'spell',f.options),null);assert.equal(opened,1);
  resolveChoice(null);await first;
  f.options.choose=async()=>({will:1});await castSpell(f.actor,'spell',f.options);
  assert.equal(f.writes.length,1);
});

test('recheck the latest will, ownership, spell and talent after the dialog',async()=>{
  for(const [change,expected] of [
    [f=>{f.actor.system.sheet.trackers.willpower=1;},/Недостаточно/],
    [f=>{f.actor.isOwner=false;},/владелец/],
    [f=>{f.talent.system.level='1';},/изменились/],
    [f=>{f.spell.system.noWillCost=true;},/изменились/],
    [f=>{f.actor.items.splice(0,1);},/отсутствует/]
  ]) {
    const f=fixture();f.options.choose=async()=>{change(f);return {will:2};};
    await assert.rejects(castSpell(f.actor,'spell',f.options),expected);
    assert.equal(f.writes.length,0);assert.equal(f.calls.length,0);assert.equal(f.messages.length,0);
  }
});

test('failed or cancelled update never rolls or posts; failures release the casting lock',async()=>{
  for(const update of [async()=>{throw Error('server rejected');},async()=>undefined]) {
    const f=fixture();f.actor.update=update;
    await assert.rejects(castSpell(f.actor,'spell',f.options),/server rejected|отменено/);
    assert.equal(f.actor.system.sheet.trackers.willpower,5);assert.equal(f.calls.length,0);assert.equal(f.messages.length,0);
    f.actor.update=async data=>{f.actor.system.sheet.trackers.willpower=data['system.sheet.trackers.willpower'];return f.actor;};
    await castSpell(f.actor,'spell',f.options);assert.equal(f.messages.length,1);
  }
});

test('an error after payment explains retained expenditure rather than refunding over a later update',async()=>{
  const f=fixture();f.options.post=async()=>{throw Error('chat unavailable');};
  await assert.rejects(castSpell(f.actor,'spell',f.options),/уже списана.*chat unavailable/);
  assert.equal(f.actor.system.sheet.trackers.willpower,3);assert.equal(f.writes.length,1);
});

test('chat escapes names and IDs, reports all dice/power metadata and never calls no sixes a failure',()=>{
  const f=fixture({free:true,level:'3'}),plan=magicPlan(magicAccess(f.actor,f.spell),{safe:true},0);
  const result=magicResult({...plan,name:'<script>',talentName:'<img>',schoolId:'a"b'},[2]);
  const content=magicChat(result,{d66:14,index:2});
  assert.ok(content.includes('&lt;script&gt;'));assert.ok(content.includes('&lt;img&gt;'));assert.ok(content.includes('a&quot;b'));
  assert.ok(content.includes('2 → 1d6'));assert.ok(content.includes('Итоговая сила: 2'));assert.ok(content.includes('D66: 14'));
  assert.ok(content.includes('Не требует'));assert.ok(content.includes('безопасное'));assert.ok(!content.includes('провал'));assert.ok(!content.includes('<script>'));
});

test('Foundry V14 dialog uses input form data, dynamic preview and nullable dismissal',async()=>{
  let config;
  const previousFoundry=globalThis.foundry;
  try {
  globalThis.foundry={applications:{api:{DialogV2:{input:async options=>{config=options;return null;}}}}};
  const f=fixture({level:'4'});
  assert.equal(await magicDialog(magicAccess(f.actor,f.spell),5),null);
  assert.equal(config.modal,true);assert.equal(config.rejectClose,false);assert.ok(config.content.includes('min="1"'));assert.ok(config.content.includes('max="5"'));
  const preview={textContent:''},elements={will:{value:'3'},safe:{checked:true}};let onInput;
  config.render({}, {form:{elements,querySelector:()=>preview,addEventListener:(_type,cb)=>{onInput=cb;}}});
  assert.ok(preview.textContent.includes('3 → 1d6'));
  elements.will.value='1';onInput();assert.ok(preview.textContent.includes('1 → 0d6'));
  const g=fixture({free:true,will:0});await magicDialog(magicAccess(g.actor,g.spell),0);
  assert.ok(!config.content.includes('name="will"'));
  } finally {globalThis.foundry=previousFoundry;}
});

test('Foundry V14 defaults apply visibility also for deterministic casts and preserve serialized rolls',async()=>{
  const f=fixture({free:true,will:0});
  let received;
  const previousChat=globalThis.ChatMessage;
  try {
  globalThis.ChatMessage={getSpeaker:()=>({actor:'mage'}),applyMode:data=>{data.whisper=['gm'];data.blind=true;},create:async data=>{received=data;return data;}};
  const roll={toJSON:()=>({formula:'2d6'})};
  await castSpell(f.actor,'spell',{choose:async()=>({}),roll:async()=>({values:[2,2],roll})});
  assert.equal(received.blind,true);assert.deepEqual(received.whisper,['gm']);assert.deepEqual(received.rolls,['{"formula":"2d6"}']);
  f.talent.system.level='4';await castSpell(f.actor,'spell',{choose:async()=>({safe:true})});
  assert.equal(received.blind,true);assert.deepEqual(received.rolls,[]);
  } finally {globalThis.ChatMessage=previousChat;}
});

test('the Foundry Roll adapter reads individual dice and rolls D66 as two d6, never as a sum',async()=>{
  const f=fixture();const previousRoll=globalThis.Roll,previousChat=globalThis.ChatMessage;
  let rolled=0,received;
  try {
    globalThis.Roll=class {
      constructor(formula){assert.equal(formula,'2d6');this.formula=formula;}
      async evaluate(){this.dice=[{results:(rolled++===0?[1,6]:[1,4]).map(result=>({result,active:true}))}];return this;}
      toJSON(){return {formula:this.formula};}
    };
    globalThis.ChatMessage={getSpeaker:()=>({}),applyMode:data=>data,create:async data=>{received=data;return data;}};
    const result=await castSpell(f.actor,'spell',{choose:async()=>({will:2})});
    assert.equal(result.result.power,3);assert.equal(result.complication.d66,14);assert.equal(result.complication.index,2);
    assert.equal(rolled,2);assert.equal(received.rolls.length,2);
  } finally {globalThis.Roll=previousRoll;globalThis.ChatMessage=previousChat;}
});
