import {DraftChanges} from './draft.mjs';

const FIELDS = {
  talent: [['level','Уровень',2,'digits']],
  weapon: [['damage','Урон',7],['bonus','Бонус',3,'signed'],['range','Дистанция',7,'range'],['durability','Прочность',3,'digits']],
  armor: [['protection','Уровень защиты',7],['penalty','Штраф',3,'signed']],
  equipment: [['bonus','Бонус',5]],
  spell: [['rank','Ранг',3,'digits'],['duration','Длительность',8],['range','Дистанция',7,'range'],['ingredients','Ингредиенты',80]]
};
const TITLES = {talent:'Талант',weapon:'Оружие',armor:'Броня',equipment:'Снаряжение',spell:'Заклинание'};
const FLAG_FIELDS = [['ritual','Ритуал'],['wordOfPower','Слово силы'],['willCost','Затраты воли']];

export class PointZeroItemSheet extends foundry.applications.api.HandlebarsApplicationMixin(foundry.applications.sheets.ItemSheetV2) {
  static DEFAULT_OPTIONS = {classes:['point-zero-window','point-zero-item-window'], position:{width:560,height:620}, window:{resizable:true}};
  static PARTS = {form:{template:'systems/point-zero/templates/item-sheet.hbs'}};
  get title() { return TITLES[this.item?.type] || 'Item'; }
  current() {
    const item=this.item;
    return {name:item.name,system:Object.fromEntries([
      ...(FIELDS[item.type]||[]).map(([key])=>key),
      'description','descriptionHeight','ritual','wordOfPower','willCost'
    ].map(key=>[key,item.system[key]]))};
  }
  async _prepareContext(options) {
    const context=await super._prepareContext(options);
    this.draft ??= new DraftChanges(this.current());
    const draft=this.draft.rebase(this.current()), item=this.item;
    return {...context,pz:{
      title:this.title,name:draft.name,nameLimit:item.type==='weapon'||item.type==='armor'?200:80,canEdit:this.isEditable,
      fields:(FIELDS[item.type]||[]).map(([key,label,max,kind=''])=>({key,label,max,kind,numeric:Boolean(kind),value:draft.system[key]??''})),
      spell:item.type==='spell',flags:FLAG_FIELDS.map(([key,label])=>({key,label,value:Boolean(draft.system[key])})),
      description:draft.system.description??'',descriptionHeight:Math.max(54,Number(draft.system.descriptionHeight)||88)
    }};
  }
  async _onRender(context, options) {
    await super._onRender(context, options);
    const root=this.element.querySelector('.pz-item-sheet');
    if (root) this.mount(root);
  }
  async _preClose(options) {
    await this.flushDraft?.();
    await super._preClose(options);
  }
  _onClose(options) {
    this.draft = null;
    this.activeKey = null;
    this.activeSelection = null;
    this.flushDraft = null;
    super._onClose(options);
  }
  mount(root) {
    const item=this.item;
    const current=()=>this.current();
    this.draft ??= new DraftChanges(current());
    this.draft.rebase(current());
    clearTimeout(this.saveTimer);
    const sanitize=el=>{
      let value=el.value;
      if(el.dataset.kind==='digits') value=value.replace(/\D/g,'');
      if(el.dataset.kind==='signed') value=(value.startsWith('-')?'-':'')+value.replace(/\D/g,'');
      if(el.dataset.kind==='range') value=value.replace(/[^\d/\\]/g,'');
      el.value=value;
      return value;
    };
    const capture=el=>{const value=el.type==='checkbox'?el.checked:sanitize(el);this.draft.change(el.dataset.key==='name'?'name':`system.${el.dataset.key}`,value);};
    const save=async()=>{clearTimeout(this.saveTimer);try{if(this.draft.conflicts.size)ui.notifications.warn('Item изменён другим пользователем: при сохранении совпадающих полей приоритет у ваших правок');this.savePromise=(this.savePromise??Promise.resolve()).catch(()=>{}).then(()=>this.draft.flush(item,'',current));await this.savePromise;}catch(error){console.error('Point Zero: item save failed',error);ui.notifications.error('Не удалось сохранить Item');throw error;}};
    this.flushDraft=save;
    const schedule=()=>{clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>save().catch(()=>{}),150);};
    root.addEventListener('input',event=>{const el=event.target;if(!this.isEditable||!el.dataset.key)return;capture(el);schedule();});
    root.addEventListener('change',event=>{const el=event.target;if(!this.isEditable||!el.dataset.key)return;capture(el);schedule();});
    const rememberFocus=el=>{if(!el.dataset.key)return;this.activeKey=el.dataset.key;this.activeSelection=typeof el.selectionStart==='number'?[el.selectionStart,el.selectionEnd]:null;};
    root.addEventListener('focusin',event=>rememberFocus(event.target));
    root.addEventListener('keyup',event=>rememberFocus(event.target));
    root.addEventListener('pointerup',event=>rememberFocus(event.target));
    root.addEventListener('pointerdown',event=>{if(!event.target.closest('[data-key]')){this.activeKey=null;this.activeSelection=null;}});
    root.addEventListener('pointerup',event=>{const el=event.target;if(this.isEditable&&el.matches('textarea[data-key="description"]')){this.draft.change('system.descriptionHeight',Math.round(el.getBoundingClientRect().height));schedule();}});
    if(this.draft.dirty.size) schedule();
    if(this.activeKey){const focused=root.querySelector(`[data-key="${this.activeKey}"]`);focused?.focus({preventScroll:true});if(focused&&this.activeSelection&&typeof focused.setSelectionRange==='function')focused.setSelectionRange(...this.activeSelection);}
  }
}
