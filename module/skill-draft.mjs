const clone = value => structuredClone(value);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);

// ArrayField updates replace the array, so edits are recorded by stable skill ID.
export class SkillDraft {
  constructor(skills) {
    this.base = clone(skills);
    this.fields = new Map();
    this.added = new Map();
    this.removed = new Map();
    this.order = null;
    this.version = 0;
    this.conflicts = new Set();
    this.inflight = null;
  }
  get hasChanges() { return Boolean(this.fields.size || this.added.size || this.removed.size || this.order); }
  snapshot() {
    return {fields:clone([...this.fields].map(([id,fields])=>[id,[...fields]])),added:clone([...this.added]),removed:clone([...this.removed]),order:clone(this.order)};
  }
  edit(id, field, value) {
    if (this.added.has(id)) {
      this.added.get(id).skill[field]=value;
      this.added.get(id).version=++this.version;
    } else {
      const original=this.base.find(skill=>skill.id===id)?.[field];
      const sending=this.inflight?.fields.some(([skillId,fields])=>skillId===id&&fields.some(([key])=>key===field));
      const fields=this.fields.get(id)??new Map();
      if (!sending && same(value,original)) fields.delete(field);
      else fields.set(field,{value:clone(value),version:++this.version});
      if (fields.size) this.fields.set(id,fields); else this.fields.delete(id);
    }
    return this.compose(this.base);
  }
  add(skill) {
    this.added.set(skill.id,{skill:clone(skill),initial:clone(skill),version:++this.version});
    return this.compose(this.base);
  }
  remove(id) {
    if (this.added.delete(id)) {
      this.order && (this.order.ids=this.order.ids.filter(key=>key!==id));
      if (this.inflight?.added.some(([key])=>key===id)) this.removed.set(id,++this.version);
    }
    else {this.fields.delete(id);this.removed.set(id,++this.version);}
    return this.compose(this.base);
  }
  reorder(ids) {
    this.order={ids:[...ids],version:++this.version};
    return this.compose(this.base);
  }
  compose(remote, changes=this.snapshot()) {
    const result=clone(remote);
    const removed=new Set(changes.removed.map(([id])=>id));
    for (let i=result.length-1;i>=0;i--) if (removed.has(result[i].id)) result.splice(i,1);
    for (const [id,fields] of changes.fields) {
      let skill=result.find(entry=>entry.id===id);
      if (!skill) {
        const old=this.base.find(entry=>entry.id===id);
        if (!old) continue;
        skill=clone(old);result.push(skill);
        this.conflicts.add(`skills.${id}`);
      }
      const previous=this.base.find(entry=>entry.id===id);
      for (const [field,{value}] of fields) {
        if (previous && !same(previous[field],skill[field]) && !same(skill[field],value)) this.conflicts.add(`skills.${id}.${field}`);
        skill[field]=clone(value);
      }
    }
    for (const [id,{skill,initial}] of changes.added) {
      const existing=result.find(entry=>entry.id===id);
      if (!existing) result.push(clone(skill));
      else {
        const sent=changes===this.inflight?null:this.inflight?.added.find(([key])=>key===id)?.[1].skill;
        const baseline=sent??initial;
        for (const [field,value] of Object.entries(skill)) if (!same(value,baseline?.[field])) existing[field]=clone(value);
      }
    }
    if (changes.order) {
      const byId=new Map(result.map(skill=>[skill.id,skill]));
      const arranged=changes.order.ids.filter(id=>byId.has(id)).map(id=>{const skill=byId.get(id);byId.delete(id);return skill;});
      return [...arranged,...byId.values()];
    }
    return result;
  }
  rebase(remote) {
    const next=this.compose(remote);
    this.base=clone(remote);
    return next;
  }
  async flush(actor, readSkills) {
    if (!this.hasChanges) return;
    const pending=this.snapshot();
    this.inflight=pending;
    try {
      const latest=readSkills();
      const merged=this.compose(latest,pending);
      if (!same(merged,latest)) {
        const result=await actor.update({'system.sheet.skills':merged});
        if (result===undefined && !same(readSkills(),merged)) throw new Error('Skill update was cancelled');
      }
      for (const [id,fields] of pending.fields) for (const [field,{version}] of fields) {
        const current=this.fields.get(id)?.get(field);
        if (current?.version===version) {
          this.fields.get(id).delete(field);
          if (!this.fields.get(id).size) this.fields.delete(id);
          this.conflicts.delete(`skills.${id}.${field}`);
        }
      }
      for (const [id,{skill,version}] of pending.added) {
        const current=this.added.get(id);
        if (current?.version===version) this.added.delete(id);
        else if (current) current.initial=clone(skill);
      }
      for (const [id,version] of pending.removed) if (this.removed.get(id)===version) this.removed.delete(id);
      if (this.order?.version===pending.order?.version) this.order=null;
      this.inflight=null;
      this.rebase(readSkills());
    } catch(error) {this.inflight=null;throw error;}
  }
}
