const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const positiveInteger = value => {
  const text=String(value ?? '').trim();
  const number=Number(text);
  return /^\d+$/.test(text) && Number.isSafeInteger(number) && number>0 ? number : null;
};
const jobs = new Set();
const willPath = 'system.sheet.trackers.willpower';
const currentWill = actor => Number(actor.system.sheet?.trackers?.willpower ?? 0);

// Names and descriptions do not define school membership. Duplicate IDs use the highest valid rank.
export function magicAccess(actor, spell) {
  if (!spell || spell.type!=='spell' || actor.items.get(spell.id)!==spell) throw new Error('Заклинание отсутствует в листе персонажа.');
  const schoolId=String(spell.system.schoolId ?? '').trim(), rank=positiveInteger(spell.system.rank);
  if (!schoolId) throw new Error('У заклинания не указан ID школы магии.');
  if (!rank) throw new Error('Ранг заклинания должен быть положительным целым числом.');
  const talents=actor.items.filter(item=>item.type==='talent' && String(item.system.linkId ?? '').trim()===schoolId && positiveInteger(item.system.level));
  talents.sort((a,b)=>positiveInteger(b.system.level)-positiveInteger(a.system.level));
  const talent=talents[0], schoolRank=talent && positiveInteger(talent.system.level);
  if (!talent) throw new Error(`Для школы «${schoolId}» нужен талант с соответствующим ID и положительным целым уровнем.`);
  if (rank>schoolRank+1) throw new Error(`Ранг заклинания ${rank} превышает уровень школы ${schoolRank} более чем на один.`);
  return {name:spell.name,schoolId,rank,schoolRank,talentName:talent.name,free:spell.system.noWillCost===true,chance:rank===schoolRank+1};
}

export function magicPlan(access, {will=1,safe=false}={}, availableWill=0) {
  const cost=access.free ? 0 : positiveInteger(will);
  if (cost===null) throw new Error('Выберите целое количество Воли, минимум 1.');
  if (!Number.isSafeInteger(availableWill) || availableWill<cost) throw new Error('Недостаточно Воли для применения заклинания.');
  const basePower=access.free ? access.rank : cost;
  const reduction=safe ? Math.max(0,access.schoolRank-access.rank) : 0;
  return {...access,cost,basePower,initialDice:basePower,dice:Math.max(0,basePower-reduction),safe:Boolean(safe && reduction>0)};
}

export function magicResult(plan, dice) {
  if (dice.length!==plan.dice || dice.some(value=>!Number.isInteger(value)||value<1||value>6)) throw new Error('Некорректный результат кубов магии.');
  const sixes=dice.filter(value=>value===6).length;
  return {...plan,values:dice,power:plan.basePower+sixes,complicationRequired:plan.chance || dice.includes(1)};
}

export function complicationIndex(tens, units) {
  if (![tens,units].every(value=>Number.isInteger(value)&&value>=1&&value<=6)) throw new Error('D66 требует два отдельных d6.');
  return (tens-1)*2+Math.ceil(units/3);
}

// Paraphrased from YZE SRD v1.0, p.31. Consequence rolls and document effects remain with the GM.
export const COMPLICATIONS = [
  'Сон не приносит отдыха: заклинатель не может спать D6 дней.',
  'Магия вызывает нервное потрясение: заклинатель получает 1 стресс.',
  'Тело страдает от магической отдачи: заклинатель получает 1 урон.',
  'В следующую смену заклинатель и все находящиеся вплотную подвергаются болезни с вирулентностью 2D6.',
  'Заклинание задевает также союзника или другую непредусмотренную цель. Помогающее заклинание затрагивает врага.',
  'Внешность заклинателя необратимо меняется. Характер изменения определяет ведущий.',
  'Заклинатель теряет зрение на весь следующий день.',
  'Заклинатель получает психическую критическую травму.',
  'Заклинатель получает физическую критическую травму.',
  'Магия привлекает демона, который явится в следующую смену.',
  'Магия обращается против заклинателя: эффект меняется на противоположный или целью становится он сам. Подробности определяет ведущий.',
  'Демон уносит заклинателя. Через D66 дней тот возвращается изменившимся персонажем ведущего.'
];

export function magicChat(result, complication) {
  return `<section class="pz-magic-result"><h3>${escape(result.name)}</h3>
    <p>Школа: ${escape(result.talentName)} (${escape(result.schoolId)}). Ранг заклинания: ${result.rank}; уровень школы: ${result.schoolRank}.</p>
    <p>${result.free?'Не требует трат Воли':`Расход Воли: ${result.cost}`}. Базовая сила: ${result.basePower}.</p>
    <p>Кубы: ${result.initialDice} → ${result.dice}d6${result.safe?' · безопасное колдовство':''}. ${result.values.length?result.values.join(', '):'Без броска'}.</p>
    <p><strong>Итоговая сила: ${result.power}</strong></p>
    ${complication?`<p><strong>Магическое осложнение — D66: ${complication.d66} (строка ${complication.index})</strong>${result.chance?' · заклинание выше уровня школы':''}</p><p>${COMPLICATIONS[complication.index-1]}</p><p>Последствия и дополнительные броски определяет ведущий; автоматически они не применяются.</p>`:'<p>Без магического осложнения.</p>'}
  </section>`;
}

export async function magicDialog(access, availableWill) {
  const free=access.free;
  const content=`<div class="pz-magic-dialog"><p><strong>${escape(access.name)}</strong></p>
    <p>Школа: ${escape(access.talentName)} (${escape(access.schoolId)}). Ранг: ${access.rank}; уровень школы: ${access.schoolRank}.</p>
    ${access.chance?'<p>Колдовство выше уровня школы: осложнение обязательно.</p>':''}
    ${free?`<p>Расход Воли: 0. Базовая сила и исходные кубы: ${access.rank}.</p>`:`<label>Расход Воли (доступно ${availableWill}) <input name="will" type="number" min="1" max="${availableWill}" step="1" value="1" required></label><p>Базовая сила и исходное число d6 равны выбранному расходу Воли.</p>`}
    ${access.schoolRank>access.rank?`<label><input name="safe" type="checkbox"> Безопасное колдовство: уменьшить число кубов на ${access.schoolRank-access.rank} (минимум 0), сохранив силу и стоимость.</label>`:''}
    <p data-magic-preview></p></div>`;
  return foundry.applications.api.DialogV2.input({
    window:{title:'Произнести заклинание'},content,modal:true,rejectClose:false,ok:{label:'Произнести'},
    render:(_event,dialog)=>{
      const form=dialog.form, preview=form.querySelector('[data-magic-preview]');
      const refresh=()=>{
        try {
          const plan=magicPlan(access,{will:form.elements.will?.value ?? 1,safe:form.elements.safe?.checked ?? false},availableWill);
          preview.textContent=`Расход: ${plan.cost}; базовая сила: ${plan.basePower}; кубы: ${plan.initialDice} → ${plan.dice}d6.`;
        } catch(error) {preview.textContent=error.message;}
      };
      form.addEventListener('input',refresh);refresh();
    }
  });
}

async function rollDice(count) {
  const roll=await new Roll(`${count}d6`).evaluate();
  const values=roll.dice.flatMap(die=>die.results.filter(result=>result.active!==false).map(result=>result.result));
  return {roll,values};
}
async function postMagic(actor, result, complication, rolls) {
  const data={speaker:ChatMessage.getSpeaker({actor}),content:magicChat(result,complication),rolls:rolls.map(roll=>JSON.stringify(roll.toJSON()))};
  // V14 reads core.messageMode by default (public / self / gm / blind).
  ChatMessage.applyMode(data);
  const message=await ChatMessage.create(data);
  if (!message) throw new Error('Отправка сообщения в чат отменена.');
  return message;
}

// Per-Actor client lock spans the dialog and commit. Foundry updates are not cross-client transactions.
export async function castSpell(actor, spellId, {
  canEdit=()=>actor.isOwner,flush=async()=>{},beginCommit=()=>{},endCommit=()=>{},
  choose=magicDialog,roll=rollDice,post=postMagic
}={}) {
  const key=actor.uuid ?? actor;
  if (jobs.has(key)) return null;
  jobs.add(key);
  let spent=0,committing=false;
  const authorize=()=>{if(!actor.isOwner || !canEdit()) throw new Error('Только владелец с правом редактирования может произнести заклинание.');};
  const access=()=>magicAccess(actor,actor.items.get(spellId));
  try {
    authorize();
    access();
    await flush();
    authorize();
    const initial=access();
    magicPlan(initial,{will:1},currentWill(actor));
    const choice=await choose(initial,currentWill(actor));
    if (!choice) return null;
    committing=true;beginCommit();
    await flush();
    authorize();
    const latest=access();
    if (JSON.stringify(latest)!==JSON.stringify(initial)) throw new Error('Параметры заклинания или школы изменились. Откройте применение заново.');
    const plan=magicPlan(latest,choice,currentWill(actor));
    if (plan.cost) {
      const remaining=currentWill(actor)-plan.cost;
      const updated=await actor.update({[willPath]:remaining});
      if (updated==null && currentWill(actor)!==remaining) throw new Error('Списание Воли отменено.');
      spent=plan.cost;
    }
    const rolls=[],rolled=plan.dice?await roll(plan.dice):{values:[]};
    if (rolled.roll) rolls.push(rolled.roll);
    const result=magicResult(plan,rolled.values);
    let complication=null;
    if (result.complicationRequired) {
      const consequence=await roll(2), [tens,units]=consequence.values;
      const index=complicationIndex(tens,units);
      complication={d66:tens*10+units,index};
      if (consequence.roll) rolls.push(consequence.roll);
    }
    await post(actor,result,complication,rolls);
    return {result,complication};
  } catch(error) {
    if (spent) throw new Error(`Воля (${spent}) уже списана; завершить применение не удалось. Перед повтором проверьте результат и остаток Воли. ${error.message}`,{cause:error});
    throw error;
  } finally {
    try {if (committing) endCommit();}
    finally {jobs.delete(key);}
  }
}
