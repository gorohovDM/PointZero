import {migrateLegacyItems} from './migration.mjs';
import {STANDARD_SKILLS} from './data-models.mjs';

const ATTRIBUTES = [['strength', 'Сила'], ['agility', 'Ловкость'], ['mind', 'Разум'], ['empathy', 'Эмпатия']];
const SKILLS = STANDARD_SKILLS;
const ITEM_TYPES = {talent: 'Таланты', weapon: 'Оружие', armor: 'Броня', equipment: 'Снаряжение', spell: 'Заклинания'};
const clone = value => JSON.parse(JSON.stringify(value));
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number.parseInt(value, 10) || 0));

function defaults() {
  return {
    header: {role:'', experience:0},
    attributes: Object.fromEntries(ATTRIBUTES.map(([id]) => [id, {max:0, current:0}])),
    trackers: {health:0, willpower:0, infection:0, radiation:0, stress:0},
    skills: SKILLS.map(([id, name, attribute]) => ({id, name, attribute, level:0, standard:true})),
    general: {age:0, sex:'', race:'', accessLevel:'', appearance:'', personality:'', goals:''},
    notes: {text:''}, ui: {textareaHeights:{}}, counters: {customSkill:0}
  };
}
function mergeState(saved) {
  const base = defaults();
  for (const key of ['header','attributes','trackers','general','notes','ui','counters']) {
    if (saved?.[key] && typeof saved[key] === 'object') base[key] = {...base[key], ...clone(saved[key])};
  }
  base.ui.textareaHeights = base.ui.textareaHeights && typeof base.ui.textareaHeights === 'object' ? base.ui.textareaHeights : {};
  for (const [id] of ATTRIBUTES) {
    base.attributes[id] = {
      max: clamp(base.attributes[id]?.max, 0, 5),
      current: clamp(base.attributes[id]?.current, 0, clamp(base.attributes[id]?.max, 0, 5))
    };
  }
  if (Array.isArray(saved?.skills)) {
    base.skills = saved.skills.filter(s => s && typeof s.id === 'string' && s.id).map(s => ({id:s.id,name:String(s.name??''),attribute:ATTRIBUTES.some(([id])=>id===s.attribute)?s.attribute:'strength',level:clamp(s.level,0,99),standard:Boolean(s.standard)}));
    for (const standard of defaults().skills) if (!base.skills.some(s => s.id === standard.id)) base.skills.push(standard);
  }
  base.counters.customSkill = Math.max(Number(base.counters.customSkill)||0, ...base.skills.map(s => Number(s.id.match(/^addskill_(\d+)$/)?.[1]||0)));
  return base;
}

export class PointZeroCharacterSheet extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.sheets.ActorSheetV2) {
  static DEFAULT_OPTIONS = {classes:['point-zero-window'], position:{width:980,height:850}, window:{resizable:true}};
  static PARTS = {form:{template:'systems/point-zero/templates/character-sheet.hbs'}};
  get title() { return 'Персонаж'; }
  activeTab = 'main';
  editingSkills = false;
  migrating = false;
  async _preFirstRender(options) {
    await super._preFirstRender(options);
    await foundry.applications.handlebars.loadTemplates({
      pzSkill:'systems/point-zero/templates/parts/skill.hbs',
      pzItemCard:'systems/point-zero/templates/parts/item-card.hbs',
      pzItemSection:'systems/point-zero/templates/parts/item-section.hbs',
      pzTracker:'systems/point-zero/templates/parts/tracker.hbs'
    });
    this.pageTemplate=await foundry.applications.handlebars.getTemplate('systems/point-zero/templates/character-content.hbs');
  }
  async _onRender(context, options) {
    await super._onRender(context, options);
    if (!this.migrating && this.isEditable && game.user.isGM) {
      try { this.migrating = true; await migrateLegacyItems(this.actor); }
      catch (error) { console.error('Point Zero: migration failed', error); ui.notifications.error('Не удалось перенести предметы Point Zero'); }
      finally { this.migrating = false; }
    }
    this.mount(this.element.querySelector('.point-zero-sheet'));
  }
  async _preClose(options) {
    try { await this.flushChanges?.(); }
    catch (error) { console.error('Point Zero: character sheet could not save before closing', error); }
    await super._preClose(options);
  }
  _onClose(options) {
    clearTimeout(this.saveTimer);
    this.localState = null;
    this.changed = false;
    this.activePath = null;
    this.activeSelection = null;
    this.flushChanges = null;
    super._onClose(options);
  }
  mount(root) {
    if (!root) return;
    const actor = this.actor;
    const current=()=>({name:actor.name,...mergeState(actor.system.sheet)});
    this.changed ??= false;
    let state = this.localState ??= current(), dragIndex = null, draggedItemId = null;
    clearTimeout(this.saveTimer);
    const content = root.querySelector('#pz-content');
    const setting = key => game.settings.get('point-zero', key);
    const get = path => path.split('.').reduce((obj, key) => obj?.[key], state);
    const set = (path, value) => {
      const keys=path.split('.'), last=keys.pop();
      keys.reduce((part,key)=>part[key]??={},state)[last]=value;
      this.changed=true;
    };
    const setSkills = skills => {state.skills=skills;this.changed=true;};
    const trackerData = (title,name,total,columns=total,module=false) => {
      const value=name==='experience'?state.header.experience:state.trackers[name];
      return {title,name,total,columns,module,cells:Array.from({length:total},(_,index)=>({index,number:index+1,on:index<value}))};
    };
    const fact = (label,value) => ({label,value:value==='' || value==null?'—':value});
    const itemSection = type => ({title:ITEM_TYPES[type],items:actor.items.filter(item=>item.type===type).sort((a,b)=>a.sort-b.sort).map(item=>{
      const s=item.system, facts=[];
      if(type==='talent')facts.push(fact('Уровень',s.level));
      if(type==='weapon')facts.push(fact('Урон',s.damage),fact('Бонус',s.bonus),fact('Дистанция',s.range),fact('Прочность',s.durability));
      if(type==='armor')facts.push(fact('Защита',s.protection),fact('Штраф',s.penalty));
      if(type==='equipment')facts.push(fact('Бонус',s.bonus));
      if(type==='spell')facts.push(fact('Ранг',s.rank),fact('Длительность',s.duration),fact('Дистанция',s.range),fact('Ингредиенты',s.ingredients));
      return {id:item.id,type,name:item.name,canEdit:this.isEditable,description:s.description,facts,
        flags:type==='spell'?[['ritual','Ритуал'],['wordOfPower','Слово силы'],['willCost','Затраты воли']].filter(([key])=>s[key]).map(([,label])=>label):[]};
    })});
    function render() {
      if (!setting('magic') && this.activeTab==='magic') this.activeTab='main';
      root.querySelector('[data-path="header.name"]').value=state.name;
      root.querySelector('[data-path="header.role"]').value=state.header.role;
      const experience=trackerData('Опыт','experience',12);
      root.querySelector('#pz-experience').innerHTML=`<div class="pz-tracker" style="--track-columns:12">${experience.cells.map(cell=>`<button type="button" class="pz-cell ${cell.on?'is-on':''}" data-tracker="experience" data-index="${cell.index}" role="checkbox" aria-checked="${cell.on}" aria-label="${cell.number} из 12"></button>`).join('')}</div>`;
      root.querySelector('[data-tab="magic"]').hidden=!setting('magic');
      root.querySelectorAll('[data-tab]').forEach(tab=>{const active=tab.dataset.tab===this.activeTab;tab.classList.toggle('is-active',active);tab.setAttribute('aria-current',active?'page':'false');});
      const area=(label,path)=>({label,path,value:get(path),height:clamp(state.ui.textareaHeights[path]||88,54,2000)});
      const view={main:this.activeTab==='main',equipment:this.activeTab==='equipment',magic:this.activeTab==='magic',bio:this.activeTab==='bio',notes:this.activeTab==='notes',
        health:trackerData('Здоровье','health',11),
        attributes:ATTRIBUTES.map(([id,name])=>({id,name,...state.attributes[id]})),
        skills:state.skills.map((skill,index)=>({...skill,index,dice:Number(state.attributes[skill.attribute]?.current||0)+Number(skill.level||0),deleteMode:this.editingSkills&&!skill.standard,options:ATTRIBUTES.map(([id,name])=>({id,name,selected:id===skill.attribute}))})),
        editingSkills:this.editingSkills,talent:itemSection('talent'),weapon:itemSection('weapon'),armor:itemSection('armor'),equipmentItems:itemSection('equipment'),spell:itemSection('spell'),
        moduleTrackers:[setting('will')&&trackerData('Сила воли','willpower',22,11,true),setting('infection')&&trackerData('Заражение','infection',24,12,true),setting('radiation')&&trackerData('Радиация','radiation',24,12,true),setting('stress')&&trackerData('Уровень стресса','stress',24,12,true)].filter(Boolean),
        general:state.general,sexes:['','Мужской','Женский','Другой'].map(value=>({value,label:value||'Не указан',selected:state.general.sex===value})),
        bioAreas:[area('Внешний вид','general.appearance'),area('Особенности характера','general.personality'),area('Цели','general.goals')],
        notesText:state.notes.text,notesHeight:clamp(state.ui.textareaHeights['notes.text']||88,54,2000)};
      content.innerHTML=this.pageTemplate(view);
      if (!this.isEditable) root.querySelectorAll('input,textarea,select,[data-tracker],[data-add],[data-delete-skill],[data-skills-settings],.pz-drag,[data-item-drag],[data-delete-item]').forEach(control=>{control.disabled=true;control.draggable=false;});
    }
    const captureHeights=()=>{if(!this.isEditable)return;content.querySelectorAll('textarea').forEach(t=>{if(t.dataset.height){const height=Math.round(t.getBoundingClientRect().height);if(height!==Number(state.ui.textareaHeights[t.dataset.height]||88))set('ui.textareaHeights',{...state.ui.textareaHeights,[t.dataset.height]:height});}});};
    const save=async()=>{
      clearTimeout(this.saveTimer);
      if(root.isConnected&&this.isEditable)captureHeights();
      if(!this.changed)return;
      const {name,...sheet}=clone(state);
      try {
        await actor.update({name:name||actor.name,'system.sheet':sheet});
        this.changed=false;
      } catch(error) {
        console.error('Point Zero: save failed',error);
        ui.notifications.error('Не удалось сохранить лист');
        throw error;
      }
    };
    this.flushChanges=save;
    const scheduleSave=()=>{clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>save().catch(()=>{}),700);};
    const toast=message=>{const node=root.querySelector('.pz-toast');node.textContent=message;node.classList.add('is-visible');setTimeout(()=>node.classList.remove('is-visible'),2200);};
    function clean(el) {
      let value=el.value;
      if(el.dataset.kind==='digits')value=value.replace(/\D/g,'');
      if(el.dataset.kind==='signed')value=(value.startsWith('-')?'-':'')+value.replace(/\D/g,'');
      if(el.dataset.kind==='range')value=value.replace(/[^\d/\\]/g,'');
      if(el.dataset.limit)value=String(clamp(value,0,Number(el.dataset.limit)));
      if(el.dataset.current)value=String(clamp(value,0,Number(state.attributes[el.dataset.current].max)));
      el.value=value;return value;
    }
    root.addEventListener('input', event=>{
      const el=event.target;
      if(!this.isEditable||!el.dataset.path)return;

      if(el.dataset.path==='header.name'){set('name',el.value);return;}
      const value=clean(el);
      if(el.dataset.path.startsWith('skills.')){const keys=el.dataset.path.split('.');state.skills[Number(keys[1])][keys[2]]=value;setSkills(state.skills);}
      else set(el.dataset.path,value);
      if(el.dataset.path.endsWith('.max')){const id=el.dataset.path.split('.')[1];set(`attributes.${id}.current`,clamp(state.attributes[id].current,0,Number(state.attributes[id].max)));const currentInput=content.querySelector(`[data-path="attributes.${id}.current"]`);if(currentInput)currentInput.value=state.attributes[id].current;}
      content.querySelectorAll('[data-roll]').forEach(button=>{const s=state.skills[Number(button.dataset.roll)];const n=Number(state.attributes[s.attribute]?.current||0)+Number(s.level||0);button.textContent=n;button.setAttribute('aria-label',`Бросить ${n} кубов`);});
    });
    root.addEventListener('change',event=>{
      const el=event.target;
      if(this.isEditable&&el.dataset.path){if(el.dataset.path==='header.name'){set('name',el.value);}else if(el.dataset.path.startsWith('skills.')){const keys=el.dataset.path.split('.');state.skills[Number(keys[1])][keys[2]]=clean(el);setSkills(state.skills);}else set(el.dataset.path,el.type==='checkbox'?el.checked:clean(el));scheduleSave();}
    });
    const rememberFocus=el=>{if(!el.dataset.path)return;this.activePath=el.dataset.path;this.activeSelection=typeof el.selectionStart==='number'?[el.selectionStart,el.selectionEnd]:null;};
    root.addEventListener('focusin',event=>rememberFocus(event.target));
    root.addEventListener('keyup',event=>rememberFocus(event.target));
    root.addEventListener('pointerup',event=>rememberFocus(event.target));
    root.addEventListener('pointerdown',event=>{if(!event.target.closest('[data-path]')){this.activePath=null;this.activeSelection=null;}});
    root.addEventListener('pointerup',event=>{
      const el=event.target;
      if(this.isEditable&&el.matches('textarea[data-height]')){scheduleSave();}
    });
    root.addEventListener('click',async event=>{
      const itemLink=event.target.closest('[data-open-item]');if(itemLink){actor.items.get(itemLink.dataset.openItem)?.sheet.render(true);return;}
      const deleteItem=event.target.closest('[data-delete-item]');if(deleteItem){if(!this.isEditable)return;await actor.deleteEmbeddedDocuments('Item',[deleteItem.dataset.deleteItem]);return;}
      const tab=event.target.closest('[data-tab]');if(tab){captureHeights();this.activeTab=tab.dataset.tab;render.call(this);return;}
      const cell=event.target.closest('[data-tracker]');if(cell){if(!this.isEditable)return;const name=cell.dataset.tracker,index=Number(cell.dataset.index)+1,path=name==='experience'?'header.experience':`trackers.${name}`,value=get(path);set(path,value===index?index-1:index);render.call(this);scheduleSave();return;}
      if(event.target.closest('[data-skills-settings]')){if(!this.isEditable)return;this.editingSkills=!this.editingSkills;render.call(this);return;}
      const addButton=event.target.closest('[data-add="skill"]');if(addButton){if(!this.isEditable)return;state.skills.push({id:`addskill_${foundry.utils.randomID()}`,name:'',attribute:'strength',level:0,standard:false});setSkills(state.skills);render.call(this);scheduleSave();return;}
      const deleteSkill=event.target.closest('[data-delete-skill]');if(deleteSkill){if(!this.isEditable)return;state.skills.splice(Number(deleteSkill.dataset.deleteSkill),1);setSkills(state.skills);render.call(this);scheduleSave();return;}
      const attributeRoll=event.target.closest('[data-attribute-roll]');if(attributeRoll){const id=attributeRoll.dataset.attributeRoll,count=Number(state.attributes[id]?.current||0);if(count<1){toast('Для броска нужен хотя бы один куб');return;}const result=await new Roll(`${count}d6`).evaluate();await result.toMessage({speaker:ChatMessage.getSpeaker({actor}),flavor:`${ATTRIBUTES.find(([key])=>key===id)?.[1]} · ${count}d6`});return;}
      const roll=event.target.closest('[data-roll]');if(roll){const s=state.skills[Number(roll.dataset.roll)],count=Number(state.attributes[s.attribute]?.current||0)+Number(s.level||0);if(count<1){toast('Для броска нужен хотя бы один куб');return;}const result=await new Roll(`${count}d6`).evaluate();await result.toMessage({speaker:ChatMessage.getSpeaker({actor}),flavor:`${esc(s.name)} · ${count}d6`});}
    });
    root.addEventListener('dragstart',event=>{
      const itemHandle=event.target.closest('[data-item-drag]');
      if(itemHandle){if(!this.isEditable)return;draggedItemId=itemHandle.dataset.itemDrag;event.dataTransfer.setData('text/plain',draggedItemId);event.dataTransfer.effectAllowed='move';event.stopPropagation();return;}
      if(!event.target.matches('.pz-drag'))return;
      if(!this.isEditable)return;
      dragIndex=Number(event.target.closest('[data-skill-index]').dataset.skillIndex);
      event.dataTransfer.setData('text/plain',String(dragIndex));event.dataTransfer.effectAllowed='move';event.stopPropagation();
    });
    root.addEventListener('dragover',event=>{if(draggedItemId&&event.target.closest('[data-pz-item-id]')){event.preventDefault();event.stopPropagation();return;}if(dragIndex!==null&&event.target.closest('[data-skill-index]')){event.preventDefault();event.stopPropagation();}});
    root.addEventListener('drop',async event=>{
      const targetCard=event.target.closest('[data-pz-item-id]');
      if(this.isEditable&&draggedItemId&&targetCard){
        event.preventDefault();event.stopPropagation();
        const source=actor.items.get(draggedItemId),target=actor.items.get(targetCard.dataset.pzItemId);
        draggedItemId=null;
        if(!source||!target||source.type!==target.type||source.id===target.id)return;
        const ordered=actor.items.filter(item=>item.type===source.type).sort((a,b)=>a.sort-b.sort);
        ordered.splice(ordered.indexOf(source),1);
        const after=event.clientY>targetCard.getBoundingClientRect().top+targetCard.getBoundingClientRect().height/2;
        ordered.splice(ordered.indexOf(target)+(after?1:0),0,source);
        await actor.updateEmbeddedDocuments('Item',ordered.map((item,index)=>({_id:item.id,sort:(index+1)*1000})));
        return;
      }
      const row=event.target.closest('[data-skill-index]');if(!this.isEditable||!row||dragIndex===null)return;
      event.preventDefault();event.stopPropagation();
      const to=Number(row.dataset.skillIndex);state.skills.splice(to,0,state.skills.splice(dragIndex,1)[0]);setSkills(state.skills);dragIndex=null;render.call(this);scheduleSave();
    });
    root.addEventListener('dragend',()=>{dragIndex=null;draggedItemId=null;});
    render.call(this);
    if(this.changed) scheduleSave();
    if(this.activePath){const focused=root.querySelector(`[data-path="${this.activePath}"]`);focused?.focus({preventScroll:true});if(focused&&this.activeSelection&&typeof focused.setSelectionRange==='function')focused.setSelectionRange(...this.activeSelection);}
  }
}
