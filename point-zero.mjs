import {PointZeroCharacterData, PointZeroItemData} from './module/data-models.mjs';
import {PointZeroCharacterSheet} from './module/character-sheet.mjs';
import {PointZeroItemSheet} from './module/item-sheet.mjs';

export const RULES = {
  magic: ['Магия', false], will: ['Воля', false], radiation: ['Радиация', false],
  infection: ['Заражение', false], stress: ['Уровень стресса', false]
};

Hooks.once('init', () => {
  CONFIG.Actor.dataModels.character = PointZeroCharacterData;
  for (const type of ['talent', 'weapon', 'armor', 'equipment', 'spell']) CONFIG.Item.dataModels[type] = PointZeroItemData;
  for (const [key, [name, defaultValue]] of Object.entries(RULES)) {
    game.settings.register('point-zero', key, {
      name: `Правила мира: ${name}`, hint: `Показывать раздел «${name}» на листах персонажей.`,
      scope: 'world', config: true, type: Boolean, default: defaultValue,
      onChange: () => { for (const actor of game.actors) if (actor.sheet?.rendered) actor.sheet.render(); }
    });
  }
  foundry.applications.apps.DocumentSheetConfig.registerSheet(foundry.documents.Actor, 'point-zero', PointZeroCharacterSheet, {
    types: ['character'], makeDefault: true, label: 'Point Zero'
  });
  foundry.applications.apps.DocumentSheetConfig.registerSheet(foundry.documents.Item, 'point-zero', PointZeroItemSheet, {
    types: ['talent', 'weapon', 'armor', 'equipment', 'spell'], makeDefault: true, label: 'Point Zero Item'
  });
});
