const copy = value => structuredClone(value);
const read = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const write = (object, path, value) => {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((value, key) => value[key] ??= {}, object);
  parent[last] = copy(value);
};

// A dirty path is the unit of ownership. Untouched paths always follow the document.
export class DraftChanges {
  constructor(documentState) {
    this.state = copy(documentState);
    this.base = copy(documentState);
    this.dirty = new Map();
    this.conflicts = new Set();
    this.versions = new Map();
    this.inflight = null;
  }
  rebase(documentState) {
    const next = copy(documentState);
    for (const [path, value] of this.dirty) {
      const remote = read(documentState,path);
      if (JSON.stringify(remote) !== JSON.stringify(read(this.base,path)) && JSON.stringify(remote) !== JSON.stringify(value)) this.conflicts.add(path);
      write(next, path, value);
    }
    this.base = copy(documentState);
    for (const key of Object.keys(this.state)) delete this.state[key];
    Object.assign(this.state, next);
    return this.state;
  }
  change(path, value) {
    write(this.state, path, value);
    this.versions.set(path,(this.versions.get(path)||0)+1);
    const sending = this.inflight?.has(path);
    if (!sending && JSON.stringify(read(this.base, path)) === JSON.stringify(value)) {this.dirty.delete(path);this.conflicts.delete(path);}
    else this.dirty.set(path, copy(value));
  }
  async flush(document, prefix = '', readState = () => this.base) {
    if (!this.dirty.size) return;
    const pending = new Map([...this.dirty].map(([path, value]) => [path, copy(value)]));
    const versions = new Map([...pending.keys()].map(path => [path,this.versions.get(path)]));
    this.inflight = pending;
    const changes = Object.fromEntries([...pending].map(([path, value]) => [typeof prefix === 'function' ? prefix(path) : prefix + path, value]));
    // Same-field conflicts use the local value; unrelated remote paths are never sent.
    try {
      const result = await document.update(changes);
      if (result === undefined && [...pending].some(([path,value]) => JSON.stringify(read(readState(),path)) !== JSON.stringify(value))) {
        throw new Error('Document update was cancelled');
      }
      for (const [path, value] of pending) {
        if (this.versions.get(path) === versions.get(path) && JSON.stringify(this.dirty.get(path)) === JSON.stringify(value)) {this.dirty.delete(path);this.conflicts.delete(path);}
      }
      this.inflight = null;
      this.rebase(readState());
    } catch (error) {
      this.inflight = null;
      throw error;
    }
  }
}
