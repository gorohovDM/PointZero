const fields = foundry.data.fields;
export const STANDARD_SKILLS = [
  ['athletics','Атлетика','strength'], ['melee','Ближний бой','strength'], ['endurance','Выносливость','strength'],
  ['stealth','Скрытность','agility'], ['sleightOfHand','Ловкость рук','agility'], ['shooting','Стрельба','agility'],
  ['medicine','Медицина','mind'], ['survival','Выживание','mind'], ['investigation','Расследование','mind'],
  ['insight','Проницательность','empathy'], ['performance','Выступление','empathy'], ['influence','Влияние','empathy']
];
const number = (max, initial = 0) => new fields.NumberField({required:true, nullable:false, integer:true, min:0, max, initial});
const string = (initial = '') => new fields.StringField({required:true, nullable:false, initial});
const schema = values => new fields.SchemaField(values, {required:true, nullable:false});
const attribute = () => schema({max:number(5), current:number(5)});
const skill = () => schema({id:string(), name:string(), attribute:new fields.StringField({required:true, nullable:false, initial:'strength', choices:['strength','agility','mind','empathy']}), level:number(99), standard:new fields.BooleanField({initial:false})});
const bounded = (value,max) => Math.min(max,Math.max(0,Number.isFinite(Number(value))?Math.trunc(Number(value)):0));

export function normalizeLegacySheet(sheet) {
  if (!sheet || typeof sheet !== 'object' || Array.isArray(sheet)) return {};
  if (sheet.header && typeof sheet.header==='object') sheet.header.experience=bounded(sheet.header.experience,12);
  if (sheet.trackers && typeof sheet.trackers==='object') for (const [key,max] of Object.entries({health:11,willpower:22,infection:24,radiation:24,stress:24})) sheet.trackers[key]=bounded(sheet.trackers[key],max);
  if (sheet.general && typeof sheet.general==='object') sheet.general.age=bounded(sheet.general.age,100000);
  if (sheet.counters && typeof sheet.counters==='object') sheet.counters.customSkill=bounded(sheet.counters.customSkill,1000000);
  if (!sheet.ui || typeof sheet.ui !== 'object') sheet.ui={};
  if (!sheet.ui.textareaHeights || typeof sheet.ui.textareaHeights !== 'object' || Array.isArray(sheet.ui.textareaHeights)) sheet.ui.textareaHeights={};
  for (const [key,value] of Object.entries(sheet.ui.textareaHeights)) sheet.ui.textareaHeights[key]=Math.max(54,bounded(value,2000));
  if (sheet.attributes && typeof sheet.attributes === 'object') for (const id of ['strength','agility','mind','empathy']) {
    if (!sheet.attributes[id] || typeof sheet.attributes[id] !== 'object') sheet.attributes[id]={};
    const pair=sheet.attributes[id];
    pair.max=bounded(pair.max,5);pair.current=bounded(pair.current,pair.max);
  }
  if (Array.isArray(sheet.skills)) sheet.skills=sheet.skills.filter(value=>value && typeof value==='object').map((value,index)=>({
    id:typeof value.id==='string' && value.id?value.id:`addskill_${index+1}`,
    name:String(value.name??''),attribute:['strength','agility','mind','empathy'].includes(value.attribute)?value.attribute:'strength',
    level:bounded(value.level,99),standard:Boolean(value.standard)
  }));
  if (Array.isArray(sheet.skills)) for (const [id,name,attribute] of STANDARD_SKILLS) if (!sheet.skills.some(skill=>skill.id===id)) sheet.skills.push({id,name,attribute,level:0,standard:true});
  return sheet;
}

export class PointZeroCharacterData extends foundry.abstract.TypeDataModel {
  static migrateData(source, options) {
    source=super.migrateData(source,options);
    if (source.sheet == null || Object.getPrototypeOf(source.sheet) === Object.prototype) source.sheet=normalizeLegacySheet(source.sheet);
    return source;
  }
  static validateJoint(data) {
    super.validateJoint(data);
    for (const id of ['strength','agility','mind','empathy']) {
      const attribute=data.sheet?.attributes?.[id];
      if (attribute && attribute.current > attribute.max) throw new Error(`Current ${id} exceeds maximum`);
    }
  }
  static defineSchema() {
    return {sheet:schema({
      header:schema({role:string(),experience:number(12)}),
      attributes:schema({strength:attribute(),agility:attribute(),mind:attribute(),empathy:attribute()}),
      trackers:schema({health:number(11),willpower:number(22),infection:number(24),radiation:number(24),stress:number(24)}),
      skills:new fields.ArrayField(skill(),{required:true,nullable:false,initial:()=>STANDARD_SKILLS.map(([id,name,attribute])=>({id,name,attribute,level:0,standard:true}))}),
      general:schema({age:number(100000),sex:string(),race:string(),accessLevel:string(),appearance:string(),personality:string(),goals:string()}),
      notes:schema({text:string()}),
      ui:schema({textareaHeights:new fields.TypedObjectField(number(2000,88),{required:true,nullable:false,initial:()=>({})})}),
      counters:schema({customSkill:number(1000000)}),
      // Retain pre-Item arrays long enough for the one-time document migration to read them.
      talents:new fields.ArrayField(new fields.ObjectField(),{required:false,nullable:true,initial:null}),
      weapons:new fields.ArrayField(new fields.ObjectField(),{required:false,nullable:true,initial:null}),
      armor:new fields.ArrayField(new fields.ObjectField(),{required:false,nullable:true,initial:null}),
      equipment:new fields.ArrayField(new fields.ObjectField(),{required:false,nullable:true,initial:null}),
      spells:new fields.ArrayField(new fields.ObjectField(),{required:false,nullable:true,initial:null})
    })};
  }
}

export class PointZeroItemData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    return {
      level: string(), damage: string(), bonus: string(), range: string(),
      durability: string(), protection: string(), penalty: string(), rank: string(),
      duration: string(), ingredients: string(), ritual: new fields.BooleanField({initial:false}),
      wordOfPower: new fields.BooleanField({initial:false}), willCost: new fields.BooleanField({initial:false}),
      description: string(), descriptionHeight: number(2000,88)
    };
  }
}
