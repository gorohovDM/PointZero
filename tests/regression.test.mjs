import test from 'node:test';
import assert from 'node:assert/strict';
import {DraftChanges} from '../module/draft.mjs';
import {SkillDraft} from '../module/skill-draft.mjs';

const updatePath = (object, path, value) => {
  const keys=path.split('.'), last=keys.pop();
  keys.reduce((part,key)=>part[key]??={},object)[last]=value;
};

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
const {PointZeroCharacterData}=await import('../module/data-models.mjs');

test('Item view refreshes remote name and untouched fields while retaining a local edit', async () => {
  const item={type:'weapon',name:'Old',system:{damage:'1',bonus:'0'}};
  const sheet=new PointZeroItemSheet();sheet.item=item;sheet.isEditable=true;
  await sheet._prepareContext({});
  sheet.draft.change('system.damage','2');
  item.name='Remote';item.system.bonus='5';
  const context=await sheet._prepareContext({});
  assert.equal(context.pz.name,'Remote');
  assert.equal(context.pz.fields.find(field=>field.key==='damage').value,'2');
  assert.equal(context.pz.fields.find(field=>field.key==='bonus').value,'5');
});

test('Item rerender re-arms pending autosave', async () => {
  let saves=0;
  const item={type:'weapon',name:'Item',system:{damage:'1'},async update(changes){saves++;for(const [path,value] of Object.entries(changes))updatePath(this,path,value);return this;}};
  const makeRoot=()=>{const listeners={};return {listeners,addEventListener(type,listener){listeners[type]=listener;},querySelector(){return null;}};};
  const sheet=new PointZeroItemSheet();sheet.item=item;sheet.isEditable=true;
  const first=makeRoot();sheet.mount(first);
  first.listeners.input({target:{dataset:{key:'damage'},type:'text',value:'2'}});
  sheet.mount(makeRoot());
  await new Promise(resolve=>setTimeout(resolve,220));
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
  test(`${Sheet.name} keeps its draft when pre-close save fails`, async () => {
    const sheet=new Sheet();sheet.draft={dirty:true};sheet.flushDraft=async()=>{throw Error('server rejected');};
    await assert.rejects(sheet._preClose({}),/server rejected/);
    assert.deepEqual(sheet.draft,{dirty:true});
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
  assert.equal(sheet.draft.dirty.size,0);
});

test('character rerender re-arms pending autosave', async () => {
  game.settings={get:()=>false};
  const makeRoot=()=>{
    const listeners={},tabs=[{dataset:{tab:'main'},classList:{toggle(){}},setAttribute(){}},{dataset:{tab:'magic'},classList:{toggle(){}},setAttribute(){}}];
    const name={value:''},role={value:''},experience={innerHTML:''},content={innerHTML:'',querySelectorAll:()=>[]};
    return {listeners,isConnected:true,addEventListener(type,listener){listeners[type]=listener;},querySelector(selector){return {'[data-path="header.name"]':name,'[data-path="header.role"]':role,'#pz-experience':experience,'[data-tab="magic"]':tabs[1],'#pz-content':content}[selector];},querySelectorAll(selector){return selector==='[data-tab]'?tabs:[];}};
  };
  let saves=0;
  const actor={name:'Actor',system:{sheet:{}},items:{filter:()=>[]},async update(changes){saves++;for(const [path,value] of Object.entries(changes))updatePath(this,path,value);return this;}};
  const sheet=new PointZeroCharacterSheet();sheet.actor=actor;sheet.isEditable=true;sheet.pageTemplate=()=>'';
  const first=makeRoot();sheet.mount(first);
  first.listeners.input({target:{dataset:{path:'header.role'},value:'Agent'}});
  sheet.mount(makeRoot());
  await new Promise(resolve=>setTimeout(resolve,220));
  assert.equal(saves,1);assert.equal(actor.system.sheet.header.role,'Agent');
});
