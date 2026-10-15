// テスト用の Firestore（メモリの中だけ）。サーバーが使っている分だけ作る
// collection・doc・add・get・set・update・orderBy・where・limit・recursiveDelete・onSnapshot（query の追加だけ）

type Data = Record<string, unknown>;
const store = new Map<string, Data>(); // ドキュメントのパス → 中身
let seq = 0;
const watchers = new Set<() => void>(); // onSnapshot で見ている query（中身が変わるたびに読みなおす）
const changed = () => watchers.forEach((w) => w());

const clone = <T>(v: T): T => structuredClone(v);
const snap = (path: string) => {
  const data = store.get(path);
  return { id: path.split('/').pop()!, exists: data !== undefined, ref: new Doc(path), data: () => (data === undefined ? undefined : clone(data)) };
};

type Filter = { field: string; op: string; value: unknown };

class Query {
  constructor(readonly path: string, private order: { field: string; dir: 'asc' | 'desc' }[] = [], private filters: Filter[] = [], private max = Infinity) {}
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc') { return new Query(this.path, [...this.order, { field, dir }], this.filters, this.max); }
  where(field: string, op: string, value: unknown) { return new Query(this.path, this.order, [...this.filters, { field, op, value }], this.max); }
  limit(n: number) { return new Query(this.path, this.order, this.filters, n); }
  async get() {
    const depth = this.path.split('/').length + 1;
    let paths = [...store.keys()].filter((p) => p.startsWith(`${this.path}/`) && p.split('/').length === depth);
    paths = paths.filter((p) => this.filters.every(({ field, op, value }) => {
      const v = store.get(p)![field] as number;
      if (op === '>') return v > (value as number);
      if (op === '==') return v === value;
      throw new Error(`fakeDb：${op} は未対応`);
    }));
    for (const { field, dir } of [...this.order].reverse()) {
      paths.sort((a, b) => {
        const x = store.get(a)![field] as number, y = store.get(b)![field] as number;
        return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
      });
    }
    const docs = paths.slice(0, this.max).map(snap);
    return { docs, empty: !docs.length, size: docs.length };
  }
  /** 足されたドキュメントだけを docChanges の added で知らせる（変更・削除は知らせない） */
  onSnapshot(next: (s: { docChanges: () => { type: 'added'; doc: ReturnType<typeof snap> }[] }) => void) {
    const seen = new Set<string>();
    const emit = async () => {
      const added = (await this.get()).docs.filter((d) => !seen.has(d.ref.path));
      added.forEach((d) => seen.add(d.ref.path));
      if (added.length) next({ docChanges: () => added.map((doc) => ({ type: 'added' as const, doc })) });
    };
    watchers.add(emit);
    void emit();
    return () => { watchers.delete(emit); };
  }
}

class Collection extends Query {
  doc(id = `auto${++seq}`) { return new Doc(`${this.path}/${id}`); }
  async add(data: Data) { const d = this.doc(); await d.set(data); return d; }
}

class Doc {
  readonly id: string;
  constructor(readonly path: string) { this.id = path.split('/').pop()!; }
  collection(name: string) { return new Collection(`${this.path}/${name}`); }
  async get() { return snap(this.path); }
  async set(data: Data, opt?: { merge?: boolean }) { store.set(this.path, clone(opt?.merge ? { ...store.get(this.path), ...data } : data)); changed(); }
  async update(patch: Data) {
    const cur = store.get(this.path);
    if (!cur) throw new Error(`fakeDb：${this.path} がありません`);
    store.set(this.path, { ...cur, ...clone(patch) });
    changed();
  }
  async delete() { store.delete(this.path); changed(); }
  onSnapshot() { return () => {}; }
}

export const fakeDb = {
  collection: (name: string) => new Collection(name),
  doc: (path: string) => new Doc(path),
  async recursiveDelete(ref: Doc) {
    for (const p of [...store.keys()]) if (p === ref.path || p.startsWith(`${ref.path}/`)) store.delete(p);
  },
  settings() {},
};

/** テストのはじめに中身を空にする */
export const resetDb = () => { store.clear(); seq = 0; };
/** パスで直接読む・書く（テストの準備と確認用） */
export const dbGet = (path: string) => store.get(path);
export const dbSet = (path: string, data: Data) => { store.set(path, clone(data)); changed(); };
/** collection のパスの直下のドキュメント（パスの順） */
export const dbList = (path: string) => [...store.entries()].filter(([p]) => p.startsWith(`${path}/`) && p.split('/').length === path.split('/').length + 1).map(([, d]) => d);
