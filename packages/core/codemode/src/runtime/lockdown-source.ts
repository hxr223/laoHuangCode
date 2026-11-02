/** Adapted from Pi's prelude lockdown; see this package's MIT license. */
export const LOCKDOWN_SOURCE = `(() => {
  const overridable = new Set(['constructor', 'name', 'message', 'toString', 'toLocaleString', 'valueOf', 'toJSON']);
  const seen = new Set([globalThis]);
  const queue = [];
  const add = value => {
    if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
      if (!seen.has(value)) { seen.add(value); queue.push(value); }
    }
  };
  for (const key of Reflect.ownKeys(globalThis)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    add(descriptor.value); add(descriptor.get); add(descriptor.set);
    if ('value' in descriptor && descriptor.configurable) Object.defineProperty(globalThis, key, { writable: false, configurable: false });
  }
  add(Object.getPrototypeOf(function* () {}));
  add(Object.getPrototypeOf(async function () {}));
  add(Object.getPrototypeOf(async function* () {}));
  add(Object.getPrototypeOf(Int8Array));
  for (const instance of [[], new Map(), new Set(), '']) add(Object.getPrototypeOf(instance[Symbol.iterator]()));
  add(Object.getPrototypeOf(/a/[Symbol.matchAll]('')));
  while (queue.length) {
    const object = queue.pop();
    add(Object.getPrototypeOf(object));
    const descriptors = Object.getOwnPropertyDescriptors(object);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key];
      add(descriptor.value); add(descriptor.get); add(descriptor.set);
      if (descriptor.writable && descriptor.configurable && (object === Object.prototype || overridable.has(key))) {
        const value = descriptor.value;
        const {get, set} = Object.getOwnPropertyDescriptor({
          get accessor() { return value; },
          set accessor(next) {
            if (this === object) throw new TypeError('Cannot assign a built-in property');
            if ((typeof this !== 'object' || this === null) && typeof this !== 'function') return;
            Object.defineProperty(this, key, { value: next, writable: true, enumerable: true, configurable: true });
          }
        }, 'accessor');
        Object.defineProperty(object, key, {get, set, enumerable: descriptor.enumerable, configurable: false});
        add(get); add(set);
      }
    }
    Object.freeze(object);
  }
})()`;
