/**
 * A stand-in DOM for the interface's tests (L4.2): just enough of elements,
 * text and events for the shell's parts to be built, read and clicked
 * without a browser. Not a test itself (no `.test.`), and never part of the
 * game's bundle (nothing the page loads imports it).
 */
export class FakeNode {
  textContent: string;
  constructor(text = '') {
    this.textContent = text;
  }
}

export class FakeEl {
  children: (FakeEl | FakeNode)[] = [];
  listeners: Record<string, ((e: unknown) => void)[]> = {};
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  className = '';
  disabled = false;
  title = '';
  type = '';
  tabIndex = 0;
  value = '';
  maxLength = 0;
  placeholder = '';
  autocomplete = '';
  spellcheck = true;
  autocapitalize = '';
  enterKeyHint = '';
  alt = '';
  src = '';
  constructor(readonly tagName: string) {}
  set textContent(t: string) {
    this.children = t ? [new FakeNode(t)] : [];
  }
  get textContent(): string {
    return this.children.map((c) => c.textContent).join('');
  }
  append(...c: (FakeEl | FakeNode)[]) {
    this.children.push(...c);
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
    return c;
  }
  replaceChildren(...c: (FakeEl | FakeNode)[]) {
    this.children = [...c];
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  addEventListener(k: string, f: (e: unknown) => void) {
    (this.listeners[k] ??= []).push(f);
  }
  fire(k: string, e: object = {}) {
    for (const f of this.listeners[k] ?? []) f({ preventDefault() {}, stopPropagation() {}, target: this, ...e });
  }
  click() {
    if (!this.disabled) this.fire('click');
  }
  focus() {
    (globalThis.document as unknown as { activeElement: unknown }).activeElement = this;
    this.fire('focus');
  }
  blur() {
    const d = globalThis.document as unknown as { activeElement: unknown };
    if (d.activeElement === this) d.activeElement = null;
  }
  contains(x: unknown): boolean {
    return x === this || this.all().includes(x as FakeEl);
  }
  all(): FakeEl[] {
    return this.children.flatMap((c) => (c instanceof FakeEl ? [c, ...c.all()] : []));
  }
  buttons() {
    return this.all().filter((e) => e.tagName === 'button');
  }
  /** The first button whose words include `text` (icons and key hints aside). */
  button(text: string) {
    return this.buttons().find((b) => b.textContent.includes(text));
  }
  byClass(cls: string) {
    return this.all().filter((e) => e.className.split(' ').includes(cls));
  }
  input() {
    return this.all().find((e) => e.tagName === 'input');
  }
}

/** Put the stand-in document in place (`activeElement` included); returns a function that takes it away. */
export function installFakeDom(): () => void {
  (globalThis as { document?: unknown }).document = { createElement: (tag: string) => new FakeEl(tag), createElementNS: (_ns: string, tag: string) => new FakeEl(tag), createTextNode: (t: string) => new FakeNode(t), activeElement: null };
  return () => {
    delete (globalThis as { document?: unknown }).document;
  };
}
