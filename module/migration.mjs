const VERSION = 1;
const TYPES = {talents:'talent',weapons:'weapon',armor:'armor',equipment:'equipment',spells:'spell'};
const jobs = new Map();

function migrationLeader() {
  const active = Array.from(game.users ?? [game.user]).filter(user=>user.active !== false && user.isGM);
  active.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  return active[0]?.id === game.user.id;
}

function migrationId(actor, legacyId) {
  // Stable 16-character Foundry ID: concurrent clients request the same document ID.
  let hash=0xcbf29ce484222325n;
  for (const char of `${actor.uuid ?? actor.id}:${legacyId}`) {
    hash^=BigInt(char.codePointAt(0));
    hash=BigInt.asUintN(64,hash*0x100000001b3n);
  }
  return hash.toString(16).padStart(16,'0');
}

async function runMigration(actor) {
  if (!actor.isOwner || !game.user.isGM || !migrationLeader()) return false;
  if (Number(actor.getFlag('point-zero','legacyMigrationVersion') || 0) >= VERSION) return false;
  const raw = actor.toObject().system?.sheet || {};
  const keys = Object.keys(TYPES).filter(key => Array.isArray(raw[key]));
  if (!keys.length) return false;
  const entries = keys.flatMap(key => raw[key].flatMap((item,index) => {
    if (typeof item?.name !== 'string' || !item.name.trim()) return [];
    const type = TYPES[key], legacyId = `${type}:${item.id ?? index}`;
    const id=migrationId(actor,legacyId);
    const idMatch=actor.items.find(existing=>existing.id===id);
    if (idMatch && idMatch.getFlag('point-zero','legacyId')!==legacyId) throw new Error(`Migration Item ID collision: ${id}`);
    if (idMatch || actor.items.some(existing => existing.getFlag('point-zero','legacyId')===legacyId)) return [];
    return [{_id:id,name:item.name,type,system:{...item,descriptionHeight:raw.ui?.textareaHeights?.[`${key}.${item.id}.description`] || 88},flags:{'point-zero':{legacyId}}}];
  }));
  if (entries.length) {
    try {await actor.createEmbeddedDocuments('Item',entries,{keepId:true});}
    catch (error) {
      if (entries.every(entry=>actor.items.some(existing=>existing.id===entry._id && existing.getFlag('point-zero','legacyId')===entry.flags['point-zero'].legacyId))) return false;
      throw error;
    }
  }
  if (Number(actor.getFlag('point-zero','legacyMigrationVersion') || 0) >= VERSION) return false;
  const fresh = actor.toObject().system?.sheet || {};
  const changes = {'flags.point-zero.legacyMigrationVersion':VERSION};
  for (const key of [...Object.keys(TYPES),'modules','editModes','itemsInitialized']) {
    if (Object.hasOwn(fresh,key) && fresh[key] != null) changes[`system.sheet.${key}`]=foundry.data.operators.ForcedDeletion.create(null);
  }
  await actor.update(changes);
  return true;
}

export async function migrateLegacyItems(actor) {
  const key=actor.uuid ?? actor.id ?? actor;
  if (jobs.has(key)) return jobs.get(key);
  const job=runMigration(actor);
  jobs.set(key,job);
  try {return await job;} finally {if (jobs.get(key)===job) jobs.delete(key);}
}
