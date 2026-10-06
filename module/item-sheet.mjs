const FIELDS = {
  talent: [['level','Уровень',2,'digits']],
  weapon: [['damage','Урон',7],['bonus','Бонус',3,'signed'],['range','Дистанция',7,'range'],['durability','Прочность',3,'digits']],
  armor: [['protection','Уровень защиты',7],['penalty','Штраф',3,'signed']],
  equipment: [['bonus','Бонус',5]],
  spell: [['schoolId','Школа магии',64,'identifier'],['rank','Ранг',3,'digits'],['duration','Длительность',8],['range','Дистанция',15],['ingredients','Ингредиенты',80]]
};
const TITLES = {talent:'Талант',weapon:'Оружие',armor:'Броня',equipment:'Снаряжение',spell:'Заклинание'};
const FLAG_FIELDS = [['ritual','Ритуал'],['wordOfPower','Слово силы'],['noWillCost','Не требует трат воли']];

export class PointZeroItemSheet extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {
  static DEFAULT_OPTIONS = {classes:['point-zero-window','point-zero-item-window'], position:{width:560,height:620}, window:{resizable:true}};
  static PARTS = {form:{template:'systems/point-zero/templates/item-sheet.hbs'}};
  get title() { return TITLES[this.item?.type] || 'Item'; }
  current() {
    const item=this.item;
    return {name:item.name,system:Object.fromEntries([
      ...(FIELDS[item.type]||[]).map(([key])=>key),
      ...(item.type==='talent'?['linkId']:[]),
      'description','descriptionHeight','ritual','wordOfPower','willCost','noWillCost'
    ].map(key=>[key,item.system[key]]))};
  }
  async _prepareContext(options) {
    const context=await super._prepareContext(options);
    const state=this.localState ??= this.current(), item=this.item;
    return {...context,pz:{
      title:this.title,name:state.name,nameLimit:item.type==='weapon'||item.type==='armor'?200:80,canEdit:this.isEditable,
      fields:(FIELDS[item.type]||[]).map(([key,label,max,kind=''])=>({key,label,max,kind,numeric:['digits','signed','range'].includes(kind),value:state.system[key]??''})),
      talent:item.type==='talent',linkId:state.system.linkId??'',
      spell:item.type==='spell',flags:FLAG_FIELDS.map(([key,label])=>({key,label,value:Boolean(state.system[key])})),
      description:state.system.description??'',descriptionHeight:Math.max(54,Number(state.system.descriptionHeight)||88)
    }};
  }
  async _onRender(context, options) {
    await super._onRender(context, options);
    const root=this.element.querySelector('.pz-item-sheet');
    if (root) this.mount(root);
  }
  async _preClose(options) {
    try { await this.flushChanges?.(); }
    catch (error) { console.error('Point Zero: Item sheet could not save before closing', error); }
    await super._preClose(options);
  }
  _onClose(options) {
    clearTimeout(this.saveTimer);
    this.localState = null;
    this.changed = false;
    this.activeKey = null;
    this.activeSelection = null;
    this.flushChanges = null;
    super._onClose(options);
  }
  mount(root) {
    const item=this.item;
    const state=this.localState ??= this.current();
    this.changed ??= false;
    clearTimeout(this.saveTimer);
    const sanitize=el=>{
      let value=el.value;
      if(el.dataset.kind==='digits') value=value.replace(/\D/g,'');
      if(el.dataset.kind==='signed') value=(value.startsWith('-')?'-':'')+value.replace(/\D/g,'');
      if(el.dataset.kind==='range') value=value.replace(/[^\d/\\]/g,'');
      if(el.dataset.kind==='identifier') value=value.replace(/[^A-Za-z0-9_-]/g,'');
      if(el.maxLength>0) value=value.slice(0,el.maxLength);
      el.value=value;
      return value;
    };
    const capture=el=>{const value=el.type==='checkbox'?el.checked:sanitize(el);if(el.dataset.key==='name')state.name=value;else state.system[el.dataset.key]=value;this.changed=true;};
    const save=async()=>{clearTimeout(this.saveTimer);if(!this.changed)return;try{await item.update({name:state.name,system:structuredClone(state.system)});this.changed=false;}catch(error){console.error('Point Zero: item save failed',error);ui.notifications.error('Не удалось сохранить Item');throw error;}};
    this.flushChanges=save;
    const schedule=()=>{clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>save().catch(()=>{}),700);};
    root.addEventListener('input',event=>{const el=event.target;if(!this.isEditable||!el.dataset.key)return;capture(el);});
    root.addEventListener('change',event=>{const el=event.target;if(!this.isEditable||!el.dataset.key)return;capture(el);schedule();});
    const rememberFocus=el=>{if(!el.dataset.key)return;this.activeKey=el.dataset.key;this.activeSelection=typeof el.selectionStart==='number'?[el.selectionStart,el.selectionEnd]:null;};
    root.addEventListener('focusin',event=>rememberFocus(event.target));
    root.addEventListener('keyup',event=>rememberFocus(event.target));
    root.addEventListener('pointerup',event=>rememberFocus(event.target));
    root.addEventListener('pointerdown',event=>{if(!event.target.closest('[data-key]')){this.activeKey=null;this.activeSelection=null;}});
    root.addEventListener('pointerup',event=>{const el=event.target;if(this.isEditable&&el.matches('textarea[data-key="description"]')){state.system.descriptionHeight=Math.round(el.getBoundingClientRect().height);this.changed=true;schedule();}});
    if(this.changed) schedule();
    if(this.activeKey){const focused=root.querySelector(`[data-key="${this.activeKey}"]`);focused?.focus({preventScroll:true});if(focused&&this.activeSelection&&typeof focused.setSelectionRange==='function')focused.setSelectionRange(...this.activeSelection);}
  }
}
