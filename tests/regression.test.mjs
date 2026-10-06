import test from 'node:test';
import assert from 'node:assert/strict';
import {DraftChanges} from '../module/draft.mjs';
import {SkillDraft} from '../module/skill-draft.mjs';
import {DoomPointsHUD, DoomPointsStore, clampDoomPoints, clampPosition, parseDoomPoints, registerDoomPointsSettings} from '../module/doom-points.mjs';

const updatePath = (object, path, value) => {
  const keys=path.split('.'), last=keys.pop();
  keys.reduce((part,key)=>part[key]??={},object)[last]=value;
};

test('Doom Points settings and number boundaries', () => {
  const registrations={};
  game.settings={register(namespace,key,config){registrations[key]=config;}};
  registerDoomPointsSettings(()=>{});
  assert.equal(registrations.doomPoints.scope,'world');
  assert.equal(registrations.doomPoints.default,0);
  assert.equal(registrations.doomPointsPosition.scope,'user');
  assert.equal(parseDoomPoints('000'),0);
  assert.equal(parseDoomPoints('999'),999);
  for(const invalid of ['', '-1', '1.5', '1e2', '1000', ' 2']) assert.equal(parseDoomPoints(invalid),null);
  assert.equal(clampDoomPoints(1200),999);
  assert.deepEqual(clampPosition({x:900,y:-5},{width:300,height:200},{width:216,height:136}),{x:84,y:0});
});

test('Doom Points changes serialize, use latest remote value, and stay out of chat', async () => {
  const previousUser=game.user;
  const previousChat=globalThis.ChatMessage;
  let value=0,release;
  let announcements=0;
  game.user={isGM:true};
  game.settings={get:()=>value,async set(namespace,key,next){
    if(next===1) await new Promise(resolve=>{release=resolve;});
    value=next;
  }};
  globalThis.ChatMessage={create:async()=>{announcements++;}};
  try {
    const store=new DoomPointsStore();
    const first=store.change(current=>current+1);
    const second=store.change(current=>current+1);
    await new Promise(resolve=>setImmediate(resolve));
    release();
    await Promise.all([first,second]);
    assert.equal(value,2);
    assert.equal(announcements,0);
    value=7; // update received from another client before the next local operation
    await store.change(current=>current-1);
    assert.equal(value,6);
    assert.equal(announcements,0);
    await store.change(6);
    assert.equal(announcements,0);
    game.user.isGM=false;
    assert.equal(await store.change(10),false);
    assert.equal(value,6);
  } finally {game.user=previousUser;globalThis.ChatMessage=previousChat;}
});

test('Doom Points save errors leave the queue usable and never announce a change', async () => {
  const previousUser=game.user;
  const previousChat=globalThis.ChatMessage;
  let value=0,fail=true,announcements=0;
  game.user={isGM:true};
  game.settings={get:()=>value,async set(namespace,key,next){if(fail){fail=false;throw Error('denied');}value=next;}};
  globalThis.ChatMessage={create:async()=>{announcements++;}};
  try {
    const store=new DoomPointsStore();
    await assert.rejects(store.change(1),/denied/);
    assert.equal(value,0);assert.equal(announcements,0);
    await store.change(1);
    assert.equal(value,1);assert.equal(announcements,0);
    await store.change(1000);
    assert.equal(value,1);assert.equal(announcements,0);
  } finally {game.user=previousUser;globalThis.ChatMessage=previousChat;}
});

test('untouched Doom Points input follows a remote update without writing back; edits and Escape behave correctly', async () => {
  const previousWindow=globalThis.window;
  const previousChat=globalThis.ChatMessage;
  const previousUser=game.user;
  let value=3, writes=0, announcements=0;
  const listeners={};
  const input={value:'3',dataset:{},select(){},addEventListener(type,callback){listeners[type]=callback;},blur(){this.lastBlur=listeners.blur();}};
  game.user={isGM:true};
  game.settings={get:()=>value,async set(namespace,key,next){writes++;value=next;}};
  globalThis.ChatMessage={create:async()=>{announcements++;}};
  globalThis.window={addEventListener(){}};
  try {
    const hud=new DoomPointsHUD();
    hud.root={addEventListener(){}};
    hud.dial={addEventListener(){}};
    hud.valueElement=input;
    hud.render=next=>{input.value=String(next);};
    hud.bind();
    listeners.focus();
    value=4; // another client changes the shared setting while this input is focused
    input.blur();
    await input.lastBlur;
    assert.equal(input.value,'4');
    assert.equal(value,4);
    assert.equal(writes,0);
    assert.equal(announcements,0);

    listeners.focus();
    value=5;
    listeners.keydown({key:'Enter',preventDefault(){}});
    await input.lastBlur;
    assert.equal(input.value,'5');
    assert.equal(writes,0);

    listeners.focus();
    input.value='6';listeners.input();
    input.blur();await input.lastBlur;
    assert.equal(value,6);
    assert.equal(writes,1);
    assert.equal(announcements,0);

    listeners.focus();
    input.value='8';listeners.input();
    value=7;
    listeners.keydown({key:'Escape',preventDefault(){}});
    await input.lastBlur;
    assert.equal(input.value,'7');
    assert.equal(value,7);
    assert.equal(writes,1);
  } finally {globalThis.window=previousWindow;globalThis.ChatMessage=previousChat;game.user=previousUser;}
});

test('an open Item follows untouched remote fields and only saves local changes', async () => {
  const item={name:'Old',system:{damage:'1',bonus:'0'},async update(changes){for(const [path,value] of Object.entries(changes))updatePath(this,path,value);}};
  const current=()=>({name:item.name,system:{...item.system}});
  const draft=new DraftChanges(current());
  draft.change('system.damage','2');
  item.name='Remote name';item.system.bonus='5';
  draft.rebase(current());
  assert.deepEqual(draft.state,{name:'Remote name',system:{damage:'2',bonus:'5'}});
  await draft.flush(item,'',current);
  assert.deepEqual({name:item.name,...item.system},{name:'Remote name',damage:'2',bonus:'5'});
});

test('same-field conflict uses the local value; failed update retains the draft', async () => {
  const item={name:'Item',system:{damage:'1'},async update(){throw Error('server rejected');}};
  const current=()=>({name:item.name,system:{...item.system}});
  const draft=new DraftChanges(current());
  draft.change('system.damage','2');item.system.damage='3';draft.rebase(current());
  await assert.rejects(draft.flush(item,'',current),/server rejected/);
  assert.equal(draft.state.system.damage,'2');
  assert.equal(draft.dirty.get('system.damage'),'2');
  item.update=async changes=>{for(const [path,value] of Object.entries(changes))updatePath(item,path,value);};
  await draft.flush(item,'',current);
  assert.equal(item.system.damage,'2');
});

test('cancelled update keeps pending changes', async () => {
  const item={name:'Item',system:{damage:'1'},async update(){return undefined;}};
  const draft=new DraftChanges({name:item.name,system:{...item.system}});
  draft.change('system.damage','2');
  await assert.rejects(draft.flush(item,'',()=>({name:item.name,system:{...item.system}})),/cancelled/);
  assert.equal(draft.dirty.get('system.damage'),'2');
});

test('a change back to the old value during an in-flight save is saved afterward', async () => {
  let release;
  const item={name:'A',async update(changes){await new Promise(resolve=>{release=resolve;});this.name=changes.name;return this;}};
  const draft=new DraftChanges({name:'A'});
  draft.change('name','B');
  const first=draft.flush(item,'',()=>({name:item.name}));
  draft.change('name','A');
  release();await first;
  assert.equal(draft.state.name,'A');
  assert.equal(draft.dirty.get('name'),'A');
  item.update=async changes=>{item.name=changes.name;return item;};
  await draft.flush(item,'',()=>({name:item.name}));
  assert.equal(item.name,'A');
  assert.equal(draft.dirty.size,0);
});

for (const [label,initial,sent] of [['false',true,false],['zero',1,0],['empty string','original','']]) {
  test(`in-flight ${label} still tracks a later revert`, async () => {
    let release;
    const document={value:initial,async update(changes){await new Promise(resolve=>{release=resolve;});this.value=changes.value;return this;}};
    const draft=new DraftChanges({value:initial});
    draft.change('value',sent);
    const first=draft.flush(document,'',()=>({value:document.value}));
    draft.change('value',initial);
    release();await first;
    assert.equal(draft.dirty.has('value'),true);
    assert.equal(draft.state.value,initial);
    document.update=async changes=>{document.value=changes.value;return document;};
    await draft.flush(document,'',()=>({value:document.value}));
    assert.equal(document.value,initial);
  });
}

test('skill field edits merge independent remote changes', async () => {
  const actor={skills:[{id:'athletics',name:'Athletics',level:0},{id:'medicine',name:'Medicine',level:0}],async update(changes){this.skills=structuredClone(changes['system.sheet.skills']);return this;}};
  const draft=new SkillDraft(actor.skills);
  draft.edit('athletics','level',2);
  actor.skills[1].level=3;
  const visible=draft.rebase(actor.skills);
  assert.equal(visible.find(skill=>skill.id==='athletics').level,2);
  assert.equal(visible.find(skill=>skill.id==='medicine').level,3);
  await draft.flush(actor,()=>actor.skills);
  assert.equal(actor.skills.find(skill=>skill.id==='athletics').level,2);
  assert.equal(actor.skills.find(skill=>skill.id==='medicine').level,3);
});

test('skill add, delete and reorder preserve a remote addition', async () => {
  const base=[{id:'a',level:0},{id:'b',level:0}];
  const actor={skills:structuredClone(base),async update(changes){this.skills=structuredClone(changes['system.sheet.skills']);return this;}};
  const draft=new SkillDraft(base);
  draft.add({id:'local',level:0});
  draft.remove('b');
  draft.reorder(['local','a']);
  actor.skills.push({id:'remote',level:5});
  await draft.flush(actor,()=>actor.skills);
  assert.deepEqual(actor.skills.map(skill=>skill.id),['local','a','remote']);
});

test('a skill edit made during an in-flight save remains pending', async () => {
  let release;
  const actor={skills:[{id:'a',level:0}],async update(changes){await new Promise(resolve=>{release=resolve;});this.skills=structuredClone(changes['system.sheet.skills']);return this;}};
  const draft=new SkillDraft(actor.skills);
  draft.edit('a','level',2);
  const first=draft.flush(actor,()=>actor.skills);
  draft.edit('a','level',0);
  release();await first;
  assert.equal(draft.hasChanges,true);
  assert.equal(draft.rebase(actor.skills)[0].level,0);
  actor.update=async changes=>{actor.skills=structuredClone(changes['system.sheet.skills']);return actor;};
  await draft.flush(actor,()=>actor.skills);
  assert.equal(actor.skills[0].level,0);
});

test('deleting a newly added skill during its save queues the deletion', async () => {
  let release;
  const actor={skills:[],async update(changes){await new Promise(resolve=>{release=resolve;});this.skills=structuredClone(changes['system.sheet.skills']);return this;}};
  const draft=new SkillDraft(actor.skills);
  draft.add({id:'local',level:0});
  const first=draft.flush(actor,()=>actor.skills);
  draft.remove('local');
  release();await first;
  assert.equal(draft.hasChanges,true);
  actor.update=async changes=>{actor.skills=structuredClone(changes['system.sheet.skills']);return actor;};
  await draft.flush(actor,()=>actor.skills);
  assert.deepEqual(actor.skills,[]);
});

test('editing a new skill during its first save persists the later name', async () => {
  let release;
  const actor={skills:[],async update(changes){await new Promise(resolve=>{release=resolve;});this.skills=structuredClone(changes['system.sheet.skills']);return this;}};
  const draft=new SkillDraft(actor.skills);
  draft.add({id:'local',name:'',level:0});
  const first=draft.flush(actor,()=>actor.skills);
  draft.edit('local','name','New name');
  release();await first;
  assert.equal(draft.rebase(actor.skills)[0].name,'New name');
  assert.equal(draft.hasChanges,true);
  actor.update=async changes=>{actor.skills=structuredClone(changes['system.sheet.skills']);return actor;};
  await draft.flush(actor,()=>actor.skills);
  assert.equal(actor.skills[0].name,'New name');
  assert.equal(draft.hasChanges,false);
});

test('a new skill can revert a pre-save edit while its first save is in flight', async () => {
  let release;
  const actor={skills:[],async update(changes){await new Promise(resolve=>{release=resolve;});this.skills=structuredClone(changes['system.sheet.skills']);return this;}};
  const draft=new SkillDraft(actor.skills);
  draft.add({id:'local',name:''});
  draft.edit('local','name','First');
  const first=draft.flush(actor,()=>actor.skills);
  draft.edit('local','name','');
  release();await first;
  assert.equal(draft.rebase(actor.skills)[0].name,'');
  actor.update=async changes=>{actor.skills=structuredClone(changes['system.sheet.skills']);return actor;};
  await draft.flush(actor,()=>actor.skills);
  assert.equal(actor.skills[0].name,'');
});

test('rerender during first skill save shows the newest local value', async () => {
  let release;
  const actor={skills:[],async update(changes){this.skills=structuredClone(changes['system.sheet.skills']);await new Promise(resolve=>{release=resolve;});return this;}};
  const draft=new SkillDraft(actor.skills);
  draft.add({id:'local',name:''});
  draft.edit('local','name','Sent');
  const first=draft.flush(actor,()=>actor.skills);
  draft.edit('local','name','Later');
  assert.equal(draft.rebase(actor.skills)[0].name,'Later');
  release();await first;
  assert.equal(draft.rebase(actor.skills)[0].name,'Later');
});

globalThis.foundry={
  applications:{api:{HandlebarsApplicationMixin:Base=>Base},sheets:{ActorSheetV2:class {async _preClose(){} _onClose(){}},ItemSheetV2:class {async _prepareContext(){return {};}async _preClose(){} _onClose(){}}}},
  abstract:{TypeDataModel:class {static migrateData(source){return source;}static validateJoint(){} }},
  utils:{randomID:()=> 'testSkillId12345'},
  data:{fields:Object.fromEntries(['NumberField','StringField','SchemaField','BooleanField','ArrayField','TypedObjectField','ObjectField'].map(name=>[name,class {constructor(...args){this.args=args;}}])),operators:{ForcedDeletion:{create:()=>({delete:true})}}}
};
globalThis.game={user:{id:'gm1',isGM:true,active:true}};
globalThis.ui={notifications:{warn(){},error(){}}};
const {PointZeroItemSheet}=await import('../module/item-sheet.mjs');
const {PointZeroCharacterSheet}=await import('../module/character-sheet.mjs');
const {migrateLegacyItems}=await import('../module/migration.mjs');
const {PointZeroCharacterData,PointZeroItemData}=await import('../module/data-models.mjs');

test('magic link IDs and spell distance survive draft rerenders and saving', async () => {
  for (const [type,key] of [['talent','linkId'],['spell','schoolId']]) {
    const item={type,name:'Old',system:{description:'Keep',range:'12345678901234567890'},async update(changes){this.name=changes.name;Object.assign(this.system,changes.system);}};
    const sheet=new PointZeroItemSheet();sheet.item=item;sheet.isEditable=true;
    const listeners={};const root={addEventListener(type,listener){listeners[type]=listener;},querySelector(){return null;}};
    sheet.mount(root);
    const input={dataset:{key,kind:'identifier'},type:'text',value:'Fire_магия-magic!'+ 'a'.repeat(80),maxLength:64};
    listeners.input({target:input});
    assert.equal(input.value,'Fire_-magic'+ 'a'.repeat(53));
    const context=await sheet._prepareContext({});
    if(type==='talent')assert.equal(context.pz.linkId,input.value);
    else {
      assert.equal(context.pz.fields[0].key,'schoolId');
      assert.equal(context.pz.fields[0].numeric,false);
      const distance=context.pz.fields.find(field=>field.key==='range');
      assert.equal(distance.kind,'');assert.equal(distance.max,15);
      // Opening an old document does not truncate its existing distance.
      assert.equal(distance.value,'12345678901234567890');
      listeners.input({target:{dataset:{key:'range',kind:''},type:'text',value:'На себя / касание',maxLength:15}});
    }
    await sheet.flushChanges();
    assert.equal(item.system[key],input.value);assert.equal(item.system.description,'Keep');
    assert.equal(item.system.range,type==='spell'?'На себя / касание'.slice(0,15):'12345678901234567890');
    sheet.isEditable=false;
    listeners.input({target:{...input,value:'changed'}});
    await sheet.flushChanges();assert.equal(item.system[key],input.value);
  }
  const schema=PointZeroItemData.defineSchema();
  assert.equal(schema.linkId.args[0].initial,'');assert.equal(schema.schoolId.args[0].initial,'');
  const sheet=new PointZeroItemSheet();sheet.item={type:'weapon',name:'Weapon',system:{}};
  const context=await sheet._prepareContext({});
  assert.equal(context.pz.fields.find(field=>field.key==='range').kind,'range');
  assert.equal(context.pz.fields.find(field=>field.key==='range').max,7);
});

test('Item view retains a local edit across rerenders', async () => {
  const item={type:'weapon',name:'Old',system:{damage:'1',bonus:'0'}};
  const sheet=new PointZeroItemSheet();sheet.item=item;sheet.isEditable=true;
  await sheet._prepareContext({});
  sheet.localState.system.damage='2';
  const context=await sheet._prepareContext({});
  assert.equal(context.pz.name,'Old');
  assert.equal(context.pz.fields.find(field=>field.key==='damage').value,'2');
});

test('old spell willCost is preserved but only the new noWillCost flag is editable and defaults to paid', async () => {
  assert.equal(PointZeroItemData.defineSchema().noWillCost.args[0].initial,false);
  for(const willCost of [true,false]) {
    const item={type:'spell',name:'Old',system:{rank:'1',schoolId:'fire',willCost},async update(changes){Object.assign(this.system,changes.system);}};
    const sheet=new PointZeroItemSheet();sheet.item=item;sheet.isEditable=true;
    const listeners={},root={addEventListener(type,cb){listeners[type]=cb;},querySelector(){return null;}};
    sheet.mount(root);
    const context=await sheet._prepareContext({});
    assert.equal(context.pz.flags.some(flag=>flag.key==='willCost'),false);
    assert.equal(context.pz.flags.find(flag=>flag.key==='noWillCost').value,false);
    listeners.input({target:{type:'checkbox',checked:true,dataset:{key:'noWillCost'}}});
    await sheet.flushChanges();
    assert.equal(item.system.willCost,willCost);assert.equal(item.system.noWillCost,true);
  }
});

test('spell casting flushes character draft and later autosave cannot restore spent will', async () => {
  game.settings={get:()=>true};
  const makeRoot=()=>{
    const listeners={},tabs=[{dataset:{tab:'main'},classList:{toggle(){}},setAttribute(){}},{dataset:{tab:'magic'},classList:{toggle(){}},setAttribute(){}}];
    const name={value:''},role={value:''},experience={innerHTML:''},content={innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};
    return {listeners,isConnected:true,addEventListener(type,cb){listeners[type]=cb;},querySelector(selector){return {'[data-path="header.name"]':name,'[data-path="header.role"]':role,'#pz-experience':experience,'[data-tab="magic"]':tabs[1],'#pz-content':content}[selector];},querySelectorAll(selector){return selector==='[data-tab]'?tabs:[];}};
  };
  const items=[{id:'spell',type:'spell',name:'Flame',sort:0,system:{rank:'1',schoolId:'fire'}},{id:'talent',type:'talent',name:'Fire',sort:0,system:{level:'3',linkId:'fire'}}];
  items.get=id=>items.find(item=>item.id===id);
  const updates=[],messages=[];
  const actor={name:'Mage',isOwner:true,items,system:{sheet:{trackers:{willpower:5}}},async update(changes){updates.push(changes);for(const [path,value] of Object.entries(changes))updatePath(this,path,value);if(sheet.magicCommitting)root.listeners.input({target:{dataset:{path:'trackers.willpower'},value:'22'}});sheet.mount(makeRoot());return this;}};
  const sheet=new PointZeroCharacterSheet();sheet.actor=actor;sheet.isEditable=true;let view;
  sheet.pageTemplate=data=>{view=data;return '';};const root=makeRoot();sheet.mount(root);
  const previousDialog=foundry.applications.api.DialogV2,previousChat=globalThis.ChatMessage;
  foundry.applications.api.DialogV2={input:async()=>{
    root.listeners.input({target:{dataset:{path:'notes.text'},value:'Edited while dialog open'}});
    root.listeners.input({target:{dataset:{path:'trackers.willpower'},value:'6'}});
    return {will:2,safe:true};
  }};
  globalThis.ChatMessage={getSpeaker:()=>({actor:'mage'}),applyMode:data=>data,create:async data=>{messages.push(data);return data;}};
  try {
    assert.equal(view.spell.items[0].canCast,true);
    root.listeners.input({target:{dataset:{path:'notes.text'},value:'Unsaved notes'}});
    root.listeners.input({target:{dataset:{path:'header.name'},value:'Renamed mage'}});
    root.listeners.input({target:{dataset:{path:'header.experience'},value:'3'}});
    root.listeners.input({target:{dataset:{path:'attributes.strength.max'},value:'2'}});
    root.listeners.input({target:{dataset:{path:'attributes.strength.current'},value:'2'}});
    root.listeners.input({target:{dataset:{path:'skills.0.level'},value:'3'}});
    await root.listeners.click({target:{closest:selector=>selector==='[data-cast-spell]'?{dataset:{castSpell:'spell'}}:null}});
    assert.equal(actor.name,'Renamed mage');assert.equal(actor.system.sheet.header.experience,3);
    assert.deepEqual(actor.system.sheet.attributes.strength,{max:2,current:2});assert.equal(actor.system.sheet.skills[0].level,'3');
    assert.equal(actor.system.sheet.trackers.willpower,4);assert.equal(actor.system.sheet.notes.text,'Edited while dialog open');
    assert.equal(sheet.localState.trackers.willpower,4);assert.equal(messages.length,1);
    assert.deepEqual(updates[2],{'system.sheet.trackers.willpower':4});
    const later=makeRoot();sheet.mount(later);
    later.listeners.input({target:{dataset:{path:'header.role'},value:'Mage role'}});
    await sheet.flushChanges();
    assert.equal(actor.system.sheet.trackers.willpower,4);assert.deepEqual(updates[3],{'system.sheet.header.role':'Mage role'});
    sheet.isEditable=false;sheet.mount(makeRoot());assert.equal(view.spell.items[0].canCast,false);
  } finally {foundry.applications.api.DialogV2=previousDialog;globalThis.ChatMessage=previousChat;}
});

test('character saves serialize and preserve newer local edits plus untouched remote fields', async () => {
  game.settings={get:()=>false};
  const makeRoot=()=>{
    const listeners={},tabs=[{dataset:{tab:'main'},classList:{toggle(){}},setAttribute(){}},{dataset:{tab:'magic'},classList:{toggle(){}},setAttribute(){}}];
    const fields={'[data-path="header.name"]':{value:''},'[data-path="header.role"]':{value:''},'#pz-experience':{innerHTML:''},'[data-tab="magic"]':tabs[1],'#pz-content':{innerHTML:'',querySelectorAll:()=>[]}};
    return {listeners,isConnected:true,addEventListener(type,cb){listeners[type]=cb;},querySelector:selector=>fields[selector],querySelectorAll:selector=>selector==='[data-tab]'?tabs:[]};
  };
  let release,active=0,maxActive=0,writes=0;
  const actor={name:'Mage',system:{sheet:{notes:{text:'Old'},trackers:{willpower:5}}},items:{filter:()=>[]},async update(changes){
    active++;maxActive=Math.max(active,maxActive);writes++;
    if(writes===1)await new Promise(resolve=>{release=resolve;});
    for(const [path,value] of Object.entries(changes))updatePath(this,path,value);
    active--;return this;
  }};
  const sheet=new PointZeroCharacterSheet();sheet.actor=actor;sheet.isEditable=true;sheet.pageTemplate=()=>'';
  const root=makeRoot();sheet.mount(root);
  root.listeners.input({target:{dataset:{path:'notes.text'},value:'First'}});
  const first=sheet.flushChanges();
  while(!release)await Promise.resolve();
  root.listeners.input({target:{dataset:{path:'notes.text'},value:'Later'}});
  root.listeners.input({target:{dataset:{path:'header.role'},value:'Agent'}});
  actor.system.sheet.trackers.willpower=3;
  sheet.mount(makeRoot());
  assert.equal(sheet.localState.notes.text,'Later');assert.equal(sheet.localState.trackers.willpower,3);
  const second=sheet.flushChanges();release();await Promise.all([first,second]);
  assert.equal(maxActive,1);assert.equal(writes,2);assert.equal(sheet.changed,false);
  assert.equal(actor.system.sheet.notes.text,'Later');assert.equal(actor.system.sheet.header.role,'Agent');assert.equal(actor.system.sheet.trackers.willpower,3);
});

test('Item rerender re-arms pending autosave', async () => {
  let saves=0;
  const item={type:'weapon',name:'Item',system:{damage:'1'},async update(changes){saves++;for(const [path,value] of Object.entries(changes))updatePath(this,path,value);return this;}};
  const makeRoot=()=>{const listeners={};return {listeners,addEventListener(type,listener){listeners[type]=listener;},querySelector(){return null;}};};
  const sheet=new PointZeroItemSheet();sheet.item=item;sheet.isEditable=true;
  const first=makeRoot();sheet.mount(first);
  first.listeners.input({target:{dataset:{key:'damage'},type:'text',value:'2'}});
  first.listeners.change({target:{dataset:{key:'damage'},type:'text',value:'2'}});
  sheet.mount(makeRoot());
  await new Promise(resolve=>setTimeout(resolve,760));
  assert.equal(saves,1);assert.equal(item.system.damage,'2');
});

test('character model starts with zero numbers and normalizes malformed old data', () => {
  const schema=PointZeroCharacterData.defineSchema().sheet.args[0];
  assert.equal(schema.trackers.args[0].health.args[0].initial,0);
  assert.equal(schema.attributes.args[0].strength.args[0].max.args[0].max,5);
  const source=PointZeroCharacterData.migrateData({sheet:{ui:{textareaHeights:null},attributes:{strength:{max:99,current:99}},skills:[{id:3,name:'Old',level:999}]}});
  assert.deepEqual(source.sheet.ui.textareaHeights,{});
  assert.deepEqual(source.sheet.attributes.strength,{max:5,current:5});
  assert.equal(source.sheet.skills[0].id,'addskill_1');
  assert.equal(source.sheet.skills[0].level,99);
  assert.throws(()=>PointZeroCharacterData.validateJoint({sheet:{attributes:{strength:{max:1,current:2}}}}),/exceeds maximum/);
});

for (const Sheet of [PointZeroItemSheet,PointZeroCharacterSheet]) {
  test(`${Sheet.name} can close after a save failure`, async () => {
    const sheet=new Sheet();sheet.flushChanges=async()=>{throw Error('server rejected');};
    const oldError=console.error;console.error=()=>{};
    try {await sheet._preClose({});} finally {console.error=oldError;}
  });
}

test('migration removes legacy arrays, marks version, and does not recreate a deleted Item', async () => {
  const actor={isOwner:true,raw:{system:{sheet:{weapons:[{id:'old-1',name:'Sword'}],header:{role:'Agent'}}}},items:[],flags:{},
    toObject(){return structuredClone(this.raw);},getFlag(scope,key){return this.flags[key];},
    async createEmbeddedDocuments(type,entries){assert.equal(type,'Item');this.items.push(...entries.map(entry=>({...entry,getFlag:(scope,key)=>entry.flags[scope][key]})));},
    async update(changes){for(const [path,value] of Object.entries(changes)){if(value?.delete)delete this.raw.system.sheet[path.split('.').at(-1)];else if(path==='flags.point-zero.legacyMigrationVersion')this.flags.legacyMigrationVersion=value;}return this;}
  };
  assert.equal(await migrateLegacyItems(actor),true);
  assert.equal(actor.items.length,1);
  assert.equal(Object.hasOwn(actor.raw.system.sheet,'weapons'),false);
  actor.items=[];
  assert.equal(await migrateLegacyItems(actor),false);
  assert.equal(actor.items.length,0);
});

test('migration is gated by permissions and never creates starter Items', async () => {
  const actor={isOwner:false,toObject(){return {system:{sheet:{weapons:[{id:'1',name:'Sword'}]}}};}};
  assert.equal(await migrateLegacyItems(actor),false);
  actor.isOwner=true;actor.getFlag=()=>null;actor.items=[];
  assert.equal(await migrateLegacyItems({...actor,toObject(){return {system:{sheet:{}}};}}),false);
});

test('migration deletes only legacy keys when notes change during Item creation', async () => {
  let release;
  const actor={id:'race-notes',isOwner:true,raw:{system:{sheet:{weapons:[{id:'w',name:'Sword'}],notes:{text:'Old'}}}},items:[],version:0,
    toObject(){return structuredClone(this.raw);},getFlag(){return this.version;},
    async createEmbeddedDocuments(type,entries){await new Promise(resolve=>{release=resolve;});this.items.push(...entries.map(entry=>({...entry,id:entry._id,getFlag:()=>entry.flags['point-zero'].legacyId})));},
    async update(changes){assert.equal(Object.hasOwn(changes,'system.sheet'),false);for(const [path,value] of Object.entries(changes)){if(value?.delete)delete this.raw.system.sheet[path.split('.').at(-1)];else this.version=value;}return this;}
  };
  const migration=migrateLegacyItems(actor);
  actor.raw.system.sheet.notes.text='New';
  release();await migration;
  assert.equal(actor.raw.system.sheet.notes.text,'New');
  assert.equal(Object.hasOwn(actor.raw.system.sheet,'weapons'),false);
});

test('parallel migration calls for one Actor create one Item', async () => {
  let release,created=0;
  const actor={id:'race-items',isOwner:true,raw:{system:{sheet:{weapons:[{id:'w',name:'Sword'}]}}},items:[],version:0,
    toObject(){return structuredClone(this.raw);},getFlag(){return this.version;},
    async createEmbeddedDocuments(type,entries){created++;await new Promise(resolve=>{release=resolve;});this.items.push(...entries.map(entry=>({...entry,id:entry._id,getFlag:()=>entry.flags['point-zero'].legacyId})));},
    async update(changes){for(const [path,value] of Object.entries(changes)){if(value?.delete)delete this.raw.system.sheet[path.split('.').at(-1)];else this.version=value;}return this;}
  };
  const first=migrateLegacyItems(actor),second=migrateLegacyItems(actor);
  release();await Promise.all([first,second]);
  assert.equal(created,1);
  assert.equal(actor.items.length,1);
});

test('only the elected active GM starts migration', async () => {
  const previous=game.user;
  game.users=[{id:'gm1',isGM:true,active:true},{id:'gm2',isGM:true,active:true}];
  game.user=game.users[1];
  const actor={id:'gm-election',isOwner:true,items:[],getFlag:()=>0,toObject(){return {system:{sheet:{weapons:[{id:'w',name:'Sword'}]}}};}};
  try {assert.equal(await migrateLegacyItems(actor),false);} finally {game.user=previous;delete game.users;}
});

test('independent GM clients use the same Item ID even with stale presence', async () => {
  const otherClient=await import('../module/migration.mjs?second-client');
  const previous=game.user;
  const gm1={id:'gm1',isGM:true,active:true},gm2={id:'gm2',isGM:true,active:true};
  let release,attempts=0;
  const barrier=new Promise(resolve=>{release=resolve;});
  const actor={id:'two-clients',isOwner:true,raw:{system:{sheet:{weapons:[{id:'w',name:'Sword'}]}}},items:[],version:0,
    toObject(){return structuredClone(this.raw);},getFlag(){return this.version;},
    async createEmbeddedDocuments(type,entries,options){attempts++;assert.equal(options.keepId,true);await barrier;for(const entry of entries){if(this.items.some(item=>item.id===entry._id))throw Error('duplicate ID');this.items.push({id:entry._id,getFlag:()=>entry.flags['point-zero'].legacyId});}},
    async update(changes){for(const [path,value] of Object.entries(changes)){if(value?.delete)delete this.raw.system.sheet[path.split('.').at(-1)];else this.version=value;}return this;}
  };
  try {
    game.user=gm1;game.users=[gm1];const first=migrateLegacyItems(actor);
    game.user=gm2;game.users=[gm2];const second=otherClient.migrateLegacyItems(actor);
    release();
    const results=await Promise.allSettled([first,second]);
    assert.equal(attempts,2);
    assert.equal(actor.items.length,1);
    assert.equal(results.filter(result=>result.status==='rejected').length,0);
  } finally {game.user=previous;delete game.users;}
});

test('read-only character sheet disables controls and ignores edits', async () => {
  game.settings={get:()=>false};
  const controls=[{disabled:false,draggable:true},{disabled:false,draggable:true}];
  const tabs=[{dataset:{tab:'main'},classList:{toggle(){}},setAttribute(){}},{dataset:{tab:'magic'},classList:{toggle(){}},setAttribute(){},hidden:false}];
  const name={value:''},role={value:''},experience={innerHTML:''},content={innerHTML:'',querySelectorAll:()=>[]};
  const listeners={};
  const root={isConnected:true,querySelector(selector){return {'[data-path="header.name"]':name,'[data-path="header.role"]':role,'#pz-experience':experience,'[data-tab="magic"]':tabs[1],'#pz-content':content}[selector];},querySelectorAll(selector){return selector==='[data-tab]'?tabs:controls;},addEventListener(type,callback){listeners[type]=callback;}};
  const actor={name:'Remote',system:{sheet:{}},items:{filter:()=>[]}};
  let view;
  const sheet=new PointZeroCharacterSheet();sheet.actor=actor;sheet.isEditable=false;sheet.pageTemplate=data=>{view=data;return '<section></section>';};
  sheet.mount(root);
  assert.equal(view.health.cells.filter(cell=>cell.on).length,0);
  assert.deepEqual(view.weapon.items,[]);
  assert.ok(controls.every(control=>control.disabled && !control.draggable));
  listeners.input({target:{dataset:{path:'header.role'},value:'Local'}});
  const target={closest(selector){return selector==='[data-tracker]'?{dataset:{tracker:'health',index:'1'}}:null;}};
  await listeners.click({target});
  assert.equal(sheet.changed,false);
});

test('character rerender re-arms pending autosave', async () => {
  game.settings={get:()=>false};
  const makeRoot=()=>{
    const listeners={},tabs=[{dataset:{tab:'main'},classList:{toggle(){}},setAttribute(){}},{dataset:{tab:'magic'},classList:{toggle(){}},setAttribute(){}}];
    const name={value:''},role={value:''},experience={innerHTML:''},content={innerHTML:'',querySelectorAll:()=>[]};
    return {listeners,isConnected:true,addEventListener(type,listener){listeners[type]=listener;},querySelector(selector){return {'[data-path="header.name"]':name,'[data-path="header.role"]':role,'#pz-experience':experience,'[data-tab="magic"]':tabs[1],'#pz-content':content}[selector];},querySelectorAll(selector){return selector==='[data-tab]'?tabs:[];}};
  };
  let saves=0;
  const actor={name:'Actor',system:{sheet:{}},items:{filter:()=>[]},async update(changes){saves++;for(const [path,value] of Object.entries(changes))updatePath(this,path,value);this.system.sheet.header.experience=Number(this.system.sheet.header.experience);return undefined;}};
  const sheet=new PointZeroCharacterSheet();sheet.actor=actor;sheet.isEditable=true;sheet.pageTemplate=()=>'';
  const first=makeRoot();sheet.mount(first);
  first.listeners.input({target:{dataset:{path:'header.role'},value:'Agent'}});
  first.listeners.input({target:{dataset:{path:'header.experience'},value:'3'}});
  first.listeners.change({target:{dataset:{path:'header.role'},value:'Agent'}});
  sheet.mount(makeRoot());
  await new Promise(resolve=>setTimeout(resolve,760));
  assert.equal(saves,1);assert.equal(actor.system.sheet.header.role,'Agent');assert.equal(actor.system.sheet.header.experience,3);
  assert.equal(sheet.changed,false);
});

test('character portrait and prototype token use Foundry Actor fields and controls', async () => {
  game.settings={get:()=>false};
  const portrait={src:''},edit={hidden:false},tokenButton={hidden:false};
  const tabs=[{dataset:{tab:'main'},classList:{toggle(){}},setAttribute(){}},{dataset:{tab:'magic'},classList:{toggle(){}},setAttribute(){}}];
  const name={value:''},role={value:''},experience={innerHTML:''},content={innerHTML:'',querySelectorAll:()=>[]};
  const listeners={};
  const root={isConnected:true,addEventListener(type,listener){listeners[type]=listener;},querySelector(selector){return {
    '[data-portrait-image]':portrait,'[data-edit-portrait]':edit,'[data-configure-token]':tokenButton,
    '[data-path="header.name"]':name,'[data-path="header.role"]':role,'#pz-experience':experience,
    '[data-tab="magic"]':tabs[1],'#pz-content':content
  }[selector];},querySelectorAll(selector){return selector==='[data-tab]'?tabs:[];}};
  const actor={name:'Agent',img:'old.webp',prototypeToken:{texture:{src:'token.webp'}},system:{sheet:{}},items:{filter:()=>[]},
    async update(changes){assert.deepEqual(Object.keys(changes),['img']);this.img=changes.img;}};
  const originalPicker=foundry.applications.apps;
  const originalConfig=globalThis.CONFIG;
  let pickerOptions,tokenOptions;
  foundry.applications.apps={FilePicker:{implementation:class {constructor(options){pickerOptions=options;}render(){return this;}}}};
  globalThis.CONFIG={Token:{prototypeSheetClass:class {constructor(options){tokenOptions=options;}render(){return this;}}}};
  try {
    const sheet=new PointZeroCharacterSheet();sheet.actor=actor;sheet.isEditable=true;sheet.pageTemplate=()=>'';
    sheet.mount(root);
    assert.equal(portrait.src,'old.webp');
    assert.equal(edit.hidden,false);assert.equal(tokenButton.hidden,false);
    await listeners.click({target:{closest(selector){return selector==='[data-edit-portrait]'?edit:null;}}});
    assert.equal(pickerOptions.type,'image');assert.equal(pickerOptions.current,'old.webp');
    await pickerOptions.callback('new.webp');
    assert.equal(actor.img,'new.webp');assert.equal(portrait.src,'new.webp');
    await listeners.click({target:{closest(selector){return selector==='[data-configure-token]'?tokenButton:null;}}});
    assert.equal(tokenOptions.prototype,actor.prototypeToken);
    sheet.isEditable=false;sheet.mount(root);
    assert.equal(edit.hidden,true);assert.equal(tokenButton.hidden,true);
  } finally {foundry.applications.apps=originalPicker;globalThis.CONFIG=originalConfig;}
});

// Keep magic checks in the existing CI entrypoint as well as available on their own.
await import('./magic.test.mjs');
