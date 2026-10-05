const SYSTEM = 'point-zero';
const VALUE_KEY = 'doomPoints';
const POSITION_KEY = 'doomPointsPosition';

export function clampDoomPoints(value) {
  return Number.isInteger(value) ? Math.max(0, Math.min(999, value)) : 0;
}

export function parseDoomPoints(text) {
  return typeof text === 'string' && /^\d{1,3}$/.test(text) ? Number(text) : null;
}

export function clampPosition(position, viewport, size) {
  const x = Number.isFinite(position?.x) ? position.x : viewport.width - size.width - 24;
  const y = Number.isFinite(position?.y) ? position.y : 120;
  return {
    x: Math.max(0, Math.min(Math.round(x), Math.max(0, viewport.width - size.width))),
    y: Math.max(0, Math.min(Math.round(y), Math.max(0, viewport.height - size.height)))
  };
}

export function registerDoomPointsSettings(onValueChange) {
  game.settings.register(SYSTEM, VALUE_KEY, {
    name: 'Doom Points', hint: 'Общий запас очков рока.',
    scope: 'world', config: false, type: Number, default: 0,
    onChange: onValueChange
  });
  game.settings.register(SYSTEM, POSITION_KEY, {
    name: 'Положение Doom Points', hint: 'Личное положение счётчика на экране.',
    scope: 'user', config: false, type: Object, default: {}
  });
}

export class DoomPointsStore {
  #queue = Promise.resolve();

  get value() { return clampDoomPoints(game.settings.get(SYSTEM, VALUE_KEY)); }

  change(request) {
    if (!game.user?.isGM) return Promise.resolve(false);
    const operation = this.#queue.then(async () => {
      if (!game.user?.isGM) return false;
      const previous = this.value;
      const requested = typeof request === 'function' ? request(previous) : request;
      if (!Number.isInteger(requested) || requested < 0 || requested > 999 || requested === previous) return false;
      await game.settings.set(SYSTEM, VALUE_KEY, requested);
      const actual = this.value;
      if (actual === previous) return false;
      const delta = actual - previous;
      try {
        await ChatMessage.create({
          content: `<p><strong>Doom Points:</strong> ${delta > 0 ? '+' : ''}${delta}; текущий запас: ${actual}.</p>`,
          speaker: {alias: 'Point Zero'}
        });
      } catch (error) {
        console.error('Point Zero: не удалось отправить изменение Doom Points в чат', error);
        ui.notifications.error('Doom Points изменены, но сообщение в чат не отправлено.');
      }
      return true;
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
}

export class DoomPointsHUD {
  constructor() { this.store = new DoomPointsStore(); }

  async mount() {
    const response = await fetch('systems/point-zero/assets/doom-points-dial.svg');
    if (!response.ok) throw new Error(`Doom Points SVG: HTTP ${response.status}`);
    const svg = await response.text();
    const root = document.createElement('div');
    root.className = `pz-doom-hud${game.user?.isGM ? ' is-gm' : ''}`;
    root.setAttribute('aria-label', 'Doom Points');
    root.innerHTML = `<button type="button" class="pz-doom-control" data-step="-1" aria-label="Уменьшить Doom Points">−</button>
      <div class="pz-doom-dial" tabindex="0" aria-label="Переместить счётчик Doom Points">${svg}
        ${game.user?.isGM ? '<input class="pz-doom-value" type="text" inputmode="numeric" maxlength="3" pattern="[0-9]{1,3}" aria-label="Текущий запас Doom Points">' : '<span class="pz-doom-value" aria-live="polite"></span>'}
      </div>
      <button type="button" class="pz-doom-control" data-step="1" aria-label="Увеличить Doom Points">+</button>`;
    document.body.append(root);
    this.root = root;
    this.valueElement = root.querySelector('.pz-doom-value');
    this.dial = root.querySelector('.pz-doom-dial');
    this.render(this.store.value);
    this.setPosition(game.settings.get(SYSTEM, POSITION_KEY), false);
    this.bind();
  }

  render(value) {
    if (!this.root) return;
    const current = clampDoomPoints(value);
    if (document.activeElement !== this.valueElement) {
      if (this.valueElement instanceof HTMLInputElement) this.valueElement.value = String(current);
      else this.valueElement.textContent = String(current);
    }
    this.root.querySelectorAll('.doom-dial__tick').forEach((tick, index) => tick.classList.toggle('is-lit', index < Math.min(current, 12)));
    this.root.querySelector('.doom-dial').classList.toggle('is-max', current >= 12);
    for (const button of this.root.querySelectorAll('[data-step]')) {
      button.disabled = !game.user?.isGM || (button.dataset.step === '-1' ? current === 0 : current === 999);
    }
  }

  setPosition(position, save) {
    const next = clampPosition(position, {width: window.innerWidth, height: window.innerHeight}, this.root.getBoundingClientRect());
    this.root.style.left = `${next.x}px`;
    this.root.style.top = `${next.y}px`;
    if (save) this.positionQueue = (this.positionQueue ?? Promise.resolve()).catch(() => {}).then(() => game.settings.set(SYSTEM, POSITION_KEY, next)).catch(error => {
      console.error('Point Zero: не удалось сохранить положение Doom Points', error);
      ui.notifications.error('Не удалось сохранить положение Doom Points.');
    });
  }

  bind() {
    this.root.addEventListener('click', async event => {
      const button = event.target.closest('[data-step]');
      if (!button || !game.user?.isGM) return;
      try { await this.store.change(value => value + Number(button.dataset.step)); }
      catch (error) { this.reportSaveError(error); }
      this.render(this.store.value);
    });
    if (game.user?.isGM) {
      const input = this.valueElement;
      input.addEventListener('focus', () => { this.editValue = input.value; input.select(); });
      input.addEventListener('beforeinput', event => {
        if (event.data && !/^\d+$/.test(event.data)) event.preventDefault();
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
        if (event.key === 'Escape') { event.preventDefault(); input.value = this.editValue; input.dataset.cancelled = 'true'; input.blur(); }
      });
      input.addEventListener('blur', async () => {
        const cancelled = input.dataset.cancelled === 'true';
        delete input.dataset.cancelled;
        const value = parseDoomPoints(input.value);
        if (!cancelled && value !== null) {
          try { await this.store.change(value); }
          catch (error) { this.reportSaveError(error); }
        } else if (!cancelled) ui.notifications.warn('Введите от 1 до 3 цифр для Doom Points.');
        this.render(this.store.value);
      });
    }
    this.dial.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('input, button')) return;
      event.preventDefault();
      const start = this.root.getBoundingClientRect();
      this.drag = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: start.left, top: start.top};
      this.dial.setPointerCapture(event.pointerId);
    });
    this.dial.addEventListener('pointermove', event => {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      this.setPosition({x: this.drag.left + event.clientX - this.drag.x, y: this.drag.top + event.clientY - this.drag.y}, false);
    });
    const finishDrag = event => {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      this.drag = null;
      this.setPosition({x: parseInt(this.root.style.left, 10), y: parseInt(this.root.style.top, 10)}, true);
    };
    this.dial.addEventListener('pointerup', finishDrag);
    this.dial.addEventListener('pointercancel', finishDrag);
    this.dial.addEventListener('keydown', event => {
      const moves = {ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10]};
      const move = moves[event.key];
      if (!move || event.target !== this.dial) return;
      event.preventDefault();
      this.setPosition({x: parseInt(this.root.style.left, 10) + move[0], y: parseInt(this.root.style.top, 10) + move[1]}, true);
    });
    window.addEventListener('resize', () => this.setPosition({x: parseInt(this.root.style.left, 10), y: parseInt(this.root.style.top, 10)}, true));
  }

  reportSaveError(error) {
    console.error('Point Zero: не удалось сохранить Doom Points', error);
    ui.notifications.error('Не удалось сохранить Doom Points.');
  }
}
